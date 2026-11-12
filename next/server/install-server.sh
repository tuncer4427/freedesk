#!/usr/bin/env bash
# FreeDesk (yeni sürüm) sunucu kurulumu: ID/sinyal sunucusu + TURN aktarma.
# Mevcut kurulumun yanına, farklı portlarla kurulur. Ubuntu + Docker.
# Bu dosya next/server/build-install-script.sh ile üretilir; elle düzenlemeyin.
set -euo pipefail

BASE=/opt/freedesk-next
SIGNAL_PORT=21200
TURN_PORT=3478
RELAY_MIN=49160
RELAY_MAX=49200

command -v docker >/dev/null 2>&1 || { echo "HATA: Docker kurulu degil"; exit 1; }
mkdir -p "$BASE/server" "$BASE/data"

PUBLIC_IP="$(curl -fsS4 --max-time 10 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if [ ! -s "$BASE/turn_secret" ]; then
  (umask 077 && openssl rand -hex 32 > "$BASE/turn_secret")
fi
TURN_SECRET="$(cat "$BASE/turn_secret")"

echo "==> Sunucu dosyalari yaziliyor..."
cat > "$BASE/server/package.json" <<'FREEDESK_EOF_PKG'
{
  "name": "freedesk-server",
  "version": "0.1.0",
  "private": true,
  "description": "FreeDesk ID and signaling server",
  "main": "server.js",
  "license": "UNLICENSED",
  "scripts": {
    "start": "node server.js",
    "test": "node test.js"
  },
  "dependencies": {
    "ws": "^8.22.2"
  }
}
FREEDESK_EOF_PKG
cat > "$BASE/server/package-lock.json" <<'FREEDESK_EOF_LOCK'
{
  "name": "freedesk-server",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "freedesk-server",
      "version": "0.1.0",
      "license": "UNLICENSED",
      "dependencies": {
        "ws": "^8.22.2"
      }
    },
    "node_modules/ws": {
      "version": "8.22.2",
      "resolved": "https://registry.npmjs.org/ws/-/ws-8.22.2.tgz",
      "integrity": "sha512-/rEZ2ejown2N5gxVTHUu9bVVC7ttu0/Tgzf5hbTOixR3Fs7mbbXgn2DbdbcKgJOmpQMtrIUWivtYuVMnp/W/yA==",
      "license": "MIT",
      "engines": {
        "node": ">=10.0.0"
      },
      "peerDependencies": {
        "bufferutil": "^4.0.1",
        "utf-8-validate": ">=5.0.2"
      },
      "peerDependenciesMeta": {
        "bufferutil": {
          "optional": true
        },
        "utf-8-validate": {
          "optional": true
        }
      }
    }
  }
}
FREEDESK_EOF_LOCK
cat > "$BASE/server/server.js" <<'FREEDESK_EOF_SRV'
'use strict';
// FreeDesk ID and signaling server.
//
// Gives every device a stable 9-digit ID, forwards connection requests to the
// device that owns the requested ID and, once that device accepts, relays the
// WebRTC handshake between the two. Screen data never passes through here: it
// flows peer to peer, or through the TURN relay when a direct path fails.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 21200);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_TTL_SECONDS = 6 * 60 * 60;

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTS_PER_MINUTE = 12;
const MAX_SOCKETS_PER_IP = 20;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_AUTH_MESSAGES = 12;
const MAX_AUTH_BYTES = 1024;
const HEARTBEAT_MS = 30 * 1000;

const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

// --- device registry (key hash -> id), persisted ---------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });
let devices = {};
try {
  devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
const usedIds = new Set(Object.values(devices));

let saveTimer = null;
function saveDevices() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DEVICES_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(devices), (err) => {
      if (err) return console.error('save failed:', err.message);
      fs.rename(tmp, DEVICES_FILE, (err2) => {
        if (err2) console.error('save failed:', err2.message);
      });
    });
  }, 500);
}

function idForDeviceKey(deviceKey) {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  if (devices[hash]) return devices[hash];
  let id;
  do {
    id = String(crypto.randomInt(100000000, 1000000000));
  } while (usedIds.has(id));
  devices[hash] = id;
  usedIds.add(id);
  saveDevices();
  return id;
}

// --- TURN credentials (coturn "use-auth-secret") ---------------------------
function iceServers() {
  if (!PUBLIC_HOST) return [];
  const servers = [{ urls: `stun:${PUBLIC_HOST}:${TURN_PORT}` }];
  if (TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS);
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({
      urls: [
        `turn:${PUBLIC_HOST}:${TURN_PORT}?transport=udp`,
        `turn:${PUBLIC_HOST}:${TURN_PORT}?transport=tcp`,
      ],
      username,
      credential,
    });
  }
  return servers;
}

// --- live state --------------------------------------------------------------
const online = new Map(); // id -> socket
const sessions = new Map(); // sessionId -> { caller, host, accepted, timer }
const socketsPerIp = new Map();

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function endSession(sessionId, notify, reason) {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  clearTimeout(session.timer);
  for (const socket of [session.caller, session.host]) {
    socket.sessions.delete(sessionId);
    if (socket !== notify?.except) send(socket, { type: 'ended', sessionId, reason });
  }
}

function allowConnect(socket) {
  const now = Date.now();
  socket.connectTimes = socket.connectTimes.filter((t) => now - t < 60 * 1000);
  if (socket.connectTimes.length >= MAX_CONNECTS_PER_MINUTE) return false;
  socket.connectTimes.push(now);
  return true;
}

const handlers = {
  hello(socket, msg) {
    if (socket.id) return;
    if (typeof msg.deviceKey !== 'string' || !/^[0-9a-f]{64}$/.test(msg.deviceKey)) {
      return send(socket, { type: 'error', code: 'bad-device-key' });
    }
    const id = idForDeviceKey(msg.deviceKey);
    const previous = online.get(id);
    if (previous && previous !== socket) previous.close(4000, 'replaced');
    socket.id = id;
    online.set(id, socket);
    send(socket, { type: 'welcome', id, iceServers: iceServers() });
  },

  connect(socket, msg) {
    const to = typeof msg.to === 'string' ? msg.to.replace(/\D/g, '') : '';
    if (!allowConnect(socket)) return send(socket, { type: 'error', code: 'rate-limited' });
    if (to === socket.id) return send(socket, { type: 'error', code: 'self' });
    const host = online.get(to);
    // Same answer for "no such ID" and "offline", so IDs cannot be enumerated.
    if (!host) return send(socket, { type: 'error', code: 'unavailable' });
    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = { caller: socket, host, accepted: false, timer: null, authMessages: 0 };
    session.timer = setTimeout(() => endSession(sessionId, null, 'timeout'), REQUEST_TIMEOUT_MS);
    sessions.set(sessionId, session);
    socket.sessions.add(sessionId);
    host.sessions.add(sessionId);
    const name = typeof msg.name === 'string' ? msg.name.slice(0, 64) : '';
    send(socket, { type: 'ringing', sessionId, to });
    send(host, { type: 'incoming', sessionId, from: socket.id, name });
  },

  answer(socket, msg) {
    const session = sessions.get(msg.sessionId);
    if (!session || session.host !== socket || session.accepted) return;
    if (msg.accept !== true) return endSession(msg.sessionId, null, 'rejected');
    session.accepted = true;
    clearTimeout(session.timer);
    const ice = iceServers();
    send(session.caller, { type: 'accepted', sessionId: msg.sessionId, iceServers: ice });
    send(session.host, { type: 'start', sessionId: msg.sessionId, iceServers: ice });
  },

  // Password check between the two devices before the host has accepted.
  // The server only forwards it; it never sees the password.
  auth(socket, msg) {
    const session = sessions.get(msg.sessionId);
    if (!session || session.accepted) return;
    const other = session.caller === socket ? session.host : session.host === socket ? session.caller : null;
    if (!other || !msg.data || typeof msg.data !== 'object') return;
    session.authMessages += 1;
    if (session.authMessages > MAX_AUTH_MESSAGES) return;
    if (JSON.stringify(msg.data).length > MAX_AUTH_BYTES) return;
    send(other, { type: 'auth', sessionId: msg.sessionId, data: msg.data });
  },

  signal(socket, msg) {
    const session = sessions.get(msg.sessionId);
    // Nothing is relayed until the host has accepted.
    if (!session || !session.accepted) return;
    const other = session.caller === socket ? session.host : session.host === socket ? session.caller : null;
    if (other) send(other, { type: 'signal', sessionId: msg.sessionId, data: msg.data });
  },

  bye(socket, msg) {
    const session = sessions.get(msg.sessionId);
    if (!session || (session.caller !== socket && session.host !== socket)) return;
    endSession(msg.sessionId, { except: socket }, 'closed');
  },
};

// --- transport ---------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, online: online.size }));
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket, req) => {
  const ip = req.socket.remoteAddress || '';
  const count = (socketsPerIp.get(ip) || 0) + 1;
  if (count > MAX_SOCKETS_PER_IP) return socket.close(4001, 'too many connections');
  socketsPerIp.set(ip, count);

  socket.id = null;
  socket.alive = true;
  socket.sessions = new Set();
  socket.connectTimes = [];

  socket.on('pong', () => {
    socket.alive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type !== 'hello' && !socket.id) return send(socket, { type: 'error', code: 'not-registered' });
    const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    if (handler) handler(socket, msg);
  });

  socket.on('close', () => {
    const left = (socketsPerIp.get(ip) || 1) - 1;
    if (left <= 0) socketsPerIp.delete(ip);
    else socketsPerIp.set(ip, left);
    if (socket.id && online.get(socket.id) === socket) online.delete(socket.id);
    for (const sessionId of [...socket.sessions]) endSession(sessionId, { except: socket }, 'disconnected');
  });

  socket.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.alive) {
      socket.terminate();
      continue;
    }
    socket.alive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`FreeDesk server listening on :${PORT}`);
});

module.exports = { httpServer, wss };
FREEDESK_EOF_SRV

echo "==> Servisler baslatiliyor..."
docker rm -f freedesk-signal freedesk-turn >/dev/null 2>&1 || true
docker run -d --name freedesk-signal --restart unless-stopped \
  -p "$SIGNAL_PORT:$SIGNAL_PORT" \
  -v "$BASE/server:/app" -v "$BASE/data:/data" -w /app \
  -e PORT="$SIGNAL_PORT" -e DATA_DIR=/data \
  -e PUBLIC_HOST="$PUBLIC_IP" -e TURN_PORT="$TURN_PORT" -e TURN_SECRET="$TURN_SECRET" \
  node:22-alpine sh -c "npm ci --omit=dev --no-audit --no-fund && exec node server.js"

# Aktarma sunucusu yalnizca internet adreslerine aktarim yapar; sunucunun
# kendi ic agina erisim icin kullanilamaz.
docker run -d --name freedesk-turn --restart unless-stopped --net=host \
  coturn/coturn:latest -n --log-file=stdout \
  --listening-port="$TURN_PORT" --external-ip="$PUBLIC_IP" --realm=freedesk \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" \
  --min-port="$RELAY_MIN" --max-port="$RELAY_MAX" \
  --fingerprint --no-cli --no-tls --no-dtls --no-multicast-peers \
  --denied-peer-ip=0.0.0.0-0.255.255.255 --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255

echo "==> Guvenlik duvari portlari..."
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "$SIGNAL_PORT/tcp"
  ufw allow "$TURN_PORT/tcp"
  ufw allow "$TURN_PORT/udp"
  ufw allow "$RELAY_MIN:$RELAY_MAX/udp"
fi

HEALTH="yanit yok"
for i in $(seq 1 60); do
  if HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:$SIGNAL_PORT/health" 2>/dev/null)"; then break; fi
  HEALTH="yanit yok"
  sleep 2
done

echo
echo "============== FREEDESK YENI SUNUCU DURUMU =============="
echo "SUNUCU: $PUBLIC_IP"
echo "SINYAL: $HEALTH"
echo "SERVISLER:"
docker ps --filter name=freedesk- --format '  {{.Names}}: {{.Status}}'
echo "========================================================="
