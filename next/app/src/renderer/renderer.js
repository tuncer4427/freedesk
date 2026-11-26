'use strict';
// UI, signaling and WebRTC for both roles: "host" (this screen is shared and
// controlled) and "viewer" (this window shows and controls a remote screen).

const $ = (id) => document.getElementById(id);
const api = window.fardesk;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const RECONNECT_MS = 3000;
const MOVE_INTERVAL_MS = 4;
const PEERS_KEY = 'fardesk.peers';
const PREFS_KEY = 'fardesk.prefs';
const ACCENTS = ['green', 'blue', 'purple', 'orange', 'red', 'slate'];
const MAX_CHAT_CHARS = 2000;
const FILE_CHUNK_BYTES = 64 * 1024;
const FILE_BUFFER_LIMIT = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PEERS = 24;
const MAX_VIEWS = 6;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_HOSTED = 5;
const MAX_REQUESTS = 5;
const PING_INTERVAL_MS = 1000;
const PING_STALE_MS = 3500;
const PING_WARN_MS = 120;
const PING_BAD_MS = 300;
const THUMB_WIDTH = 320;

// What the host's encoder aims for; the viewer picks one.
const QUALITY = {
  speed: { maxBitrate: 3 * 1000 * 1000, maxFramerate: 60, hint: 'motion' },
  balanced: { maxBitrate: 10 * 1000 * 1000, maxFramerate: 60, hint: 'detail' },
  quality: { maxBitrate: 24 * 1000 * 1000, maxFramerate: 30, hint: 'detail' },
};
const CAPTURE_FRAMERATE = 60;

const ICONS = {
  screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H4zM9 20h6M12 16v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  starOn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h3l10-10-3-3L5 16zM14 7l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

let info = null;
let socket = null;
let myId = null;
let pending = null; // an outgoing request waiting for an answer: { sessionId, to }
const views = new Map(); // sessionId -> link, remote screens open in tabs
let active = null; // the remote screen on display (one of views)
const hosted = new Map(); // sessionId -> link, the computers connected to this one
const requests = new Map(); // sessionId -> incoming request waiting for a decision
const captures = new Map(); // displayId -> screen capture shared by the links showing it
let captureChain = Promise.resolve(); // one capture request at a time
let displays = []; // this computer's screens, main screen first
let mic = null; // this computer's microphone stream while voice is on
let activeTab = 'recent';
let prefs = null;

const formatId = (id) => id.replace(/(\d{3})(?=\d)/g, '$1 ');
const digits = (text) => text.replace(/\D/g, '').slice(0, 9);

// --- stored preferences and known computers ---------------------------------
function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function loadPrefs() {
  const saved = readJson(PREFS_KEY, {});
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  return {
    name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.slice(0, 40) : info.name,
    theme: pick(saved.theme, ['system', 'light', 'dark'], 'system'),
    quality: pick(saved.quality, Object.keys(QUALITY), 'balanced'),
    scale: pick(saved.scale, ['fit', 'original'], 'fit'),
    accent: pick(saved.accent, ACCENTS, 'green'),
    allowFiles: saved.allowFiles !== false,
    background: saved.background !== false,
    sounds: saved.sounds !== false,
    confirmSwitch: saved.confirmSwitch !== false,
    cursorName: saved.cursorName !== false,
    allowControl: saved.allowControl !== false,
    allowClipboard: saved.allowClipboard !== false,
  };
}

function savePrefs() {
  writeJson(PREFS_KEY, prefs);
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.accent = prefs.accent;
  for (const swatch of document.querySelectorAll('.swatch')) swatch.setAttribute('aria-checked', String(swatch.dataset.accent === prefs.accent));
}

function loadPeers() {
  const list = readJson(PEERS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((peer) => peer && /^\d{9}$/.test(peer.id))
    .map((peer) => ({
      id: peer.id,
      name: typeof peer.name === 'string' ? peer.name.slice(0, 40) : '',
      fav: peer.fav === true,
      last: Number.isFinite(peer.last) ? peer.last : 0,
      thumb: typeof peer.thumb === 'string' && peer.thumb.startsWith('data:image/jpeg;base64,') ? peer.thumb : '',
      // Remembered access key for this computer (never the password itself).
      salt: HEX32.test(peer.salt) && HEX64.test(peer.key) ? peer.salt : '',
      key: HEX32.test(peer.salt) && HEX64.test(peer.key) ? peer.key : '',
    }));
}

function savePeers(list) {
  // Favorites are always kept; the oldest other entries are dropped first.
  const sorted = [...list].sort((a, b) => b.last - a.last);
  const kept = [...sorted.filter((p) => p.fav), ...sorted.filter((p) => !p.fav)].slice(0, MAX_PEERS);
  writeJson(PEERS_KEY, kept);
  renderPeers();
}

function updatePeer(id, change) {
  const list = loadPeers();
  let peer = list.find((p) => p.id === id);
  if (!peer) {
    peer = { id, name: '', fav: false, last: 0, thumb: '', salt: '', key: '' };
    list.push(peer);
  }
  Object.assign(peer, change);
  savePeers(list);
}

function removePeer(id) {
  savePeers(loadPeers().filter((p) => p.id !== id));
}

function peerAction(icon, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'peer-action';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.addEventListener('click', onClick);
  return button;
}

function renderPeers() {
  const all = loadPeers().sort((a, b) => b.last - a.last);
  const list = activeTab === 'favorites' ? all.filter((p) => p.fav) : all;
  const box = $('peers');
  box.replaceChildren();
  $('peers-empty').hidden = list.length > 0;
  $('peers-empty').textContent =
    activeTab === 'favorites'
      ? 'Henüz favori yok. Bir bilgisayarı favorilere eklemek için yıldıza basın.'
      : 'Henüz bağlantı yok. Yukarıya bir adres yazıp Bağlan’a basın.';
  for (const peer of list) {
    const card = document.createElement('div');
    card.className = 'peer';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'peer-open';
    open.title = 'Bağlan';
    open.setAttribute('aria-label', `${peer.name || formatId(peer.id)} bilgisayarına bağlan`);
    if (peer.thumb) open.style.backgroundImage = `url("${peer.thumb}")`;
    else open.innerHTML = ICONS.screen;
    open.addEventListener('click', () => connectTo(peer.id));

    const text = document.createElement('div');
    text.className = 'peer-text';
    const name = document.createElement('div');
    name.className = 'peer-name';
    name.textContent = peer.name || formatId(peer.id);
    text.append(name);
    if (peer.name) {
      const idLine = document.createElement('div');
      idLine.className = 'peer-id';
      idLine.textContent = formatId(peer.id);
      text.append(idLine);
    }

    const rename = peerAction(ICONS.edit, 'Ad ver', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'peer-name-input';
      input.maxLength = 40;
      input.value = peer.name;
      input.placeholder = 'Ad';
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        if (save) updatePeer(peer.id, { name: input.value.trim() });
        else renderPeers();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      text.replaceChildren(input);
      input.focus();
    });
    const star = peerAction(peer.fav ? ICONS.starOn : ICONS.star, peer.fav ? 'Favorilerden çıkar' : 'Favorilere ekle', () =>
      updatePeer(peer.id, { fav: !peer.fav }),
    );
    star.setAttribute('aria-pressed', String(peer.fav));
    const remove = peerAction(ICONS.remove, 'Listeden kaldır', () => removePeer(peer.id));

    const row = document.createElement('div');
    row.className = 'peer-info';
    row.append(text, rename, star, remove);
    card.append(open, row);
    box.append(card);
  }
}

// --- status and messages -----------------------------------------------------
function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status').title = text;
  $('status-text').textContent = text;
  $('connect-button').disabled = state !== 'online' || digits($('remote-id').value).length !== 9;
}

function setMessage(text) {
  $('connect-message').textContent = text || '';
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// Every open connection: the remote screens open in tabs and the computers
// connected to this one. Both can be open at the same time.
const links = () => [...views.values(), ...hosted.values()];
const viewingNow = () => Boolean(active) && !$('viewer').hidden;
// Where chat, files, voice and the clipboard go: the remote screen on
// display; otherwise everyone connected to this computer.
const targets = () => {
  if (viewingNow()) return [active];
  if (hosted.size > 0) return [...hosted.values()];
  return active ? [active] : [];
};
const findLink = (sessionId) => views.get(sessionId) || hosted.get(sessionId) || null;
const linkLabel = (link) => link.name || formatId(link.peerId);
const sessionTitle = (link) => (link.name ? `${link.name} · ${formatId(link.peerId)}` : formatId(link.peerId));
// Who a message came from, when more than one computer could have sent it.
const fromLabel = (link) => (link.role === 'host' || links().length > 1 ? linkLabel(link) : '');

function connectTo(id) {
  if (id.length !== 9 || pending || !myId) return;
  const open = [...views.values()].find((link) => link.peerId === id);
  if (open) {
    requestSwitch(open);
    return;
  }
  if (views.size >= MAX_VIEWS) {
    setMessage(`Aynı anda en fazla ${MAX_VIEWS} oturum açık olabilir. Yeni bağlantı için birini kapatın.`);
    return;
  }
  $('remote-id').value = formatId(id);
  setMessage('Bağlanıyor…');
  send({ type: 'connect', to: id, name: prefs.name });
}

// --- sounds ------------------------------------------------------------------
let audioContext = null;
function chime(notes) {
  try {
    audioContext = audioContext || new AudioContext();
    const start = audioContext.currentTime;
    notes.forEach((frequency, index) => {
      const at = start + index * 0.11;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.22);
    });
  } catch {}
}
const messageSound = () => prefs.sounds && chime([880, 1175]);
const requestSound = () => prefs.sounds && chime([660, 880, 660]);

// --- signaling ---------------------------------------------------------------
function connectServer() {
  setStatus('connecting', 'Sunucuya bağlanıyor…');
  socket = new WebSocket(info.serverUrl);
  socket.onopen = () => send({ type: 'hello', deviceKey: info.deviceKey });
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    onServerMessage(msg);
  };
  socket.onclose = () => {
    myId = null;
    $('copy-id').disabled = true;
    setStatus('offline', 'Sunucuya bağlanılamıyor, yeniden deneniyor…');
    if (pending) {
      pending = null;
      hidePasswordBox();
      setMessage('Sunucu bağlantısı koptu.');
    }
    for (const sessionId of [...requests.keys()]) dropRequest(sessionId);
    setTimeout(connectServer, RECONNECT_MS);
  };
  socket.onerror = () => {};
}

const ERRORS = {
  unavailable: 'Bu adres şu anda çevrimiçi değil ya da yanlış.',
  self: 'Bu, kendi bilgisayarınızın adresi.',
  'rate-limited': 'Çok fazla deneme yapıldı. Bir dakika sonra tekrar deneyin.',
};

const END_REASONS = {
  rejected: 'Karşı taraf isteği reddetti.',
  timeout: 'Karşı taraf yanıt vermedi.',
  disconnected: 'Karşı tarafın bağlantısı koptu.',
  closed: 'Bağlantı sonlandırıldı.',
};

function onServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      $('my-id').textContent = formatId(myId);
      $('copy-id').disabled = false;
      setStatus('online', 'Hazır');
      break;
    case 'error':
      pending = null;
      hidePasswordBox();
      setMessage(ERRORS[msg.code] || 'Bağlantı kurulamadı.');
      setStatus('online', 'Hazır');
      break;
    case 'ringing':
      pending = { sessionId: msg.sessionId, to: msg.to };
      setMessage('Karşı tarafın onayı bekleniyor…');
      break;
    case 'incoming':
      onIncoming(msg);
      break;
    case 'auth':
      onAuth(msg);
      break;
    case 'accepted':
      if (pending && pending.sessionId === msg.sessionId) startViewer(msg);
      break;
    case 'start':
      if (requests.has(msg.sessionId)) startHost(msg);
      break;
    case 'signal': {
      const link = findLink(msg.sessionId);
      if (link) queueSignal(link, msg.data);
      break;
    }
    case 'ended':
      onEnded(msg);
      break;
    default:
  }
}

function onEnded(msg) {
  if (pending && pending.sessionId === msg.sessionId) {
    pending = null;
    hidePasswordBox();
    setMessage(END_REASONS[msg.reason] || 'Bağlantı kurulamadı.');
  }
  if (requests.has(msg.sessionId)) dropRequest(msg.sessionId);
  const link = findLink(msg.sessionId);
  if (link) {
    endLink(link, false);
    if (link.role === 'viewer') setMessage(END_REASONS[msg.reason] || 'Bağlantı sonlandı.');
  }
}

// --- incoming requests (host side) -------------------------------------------
// Requests are shown one at a time in a small window in the middle of the
// screen, so they are seen even when FarDesk itself is in the background.
function onIncoming(msg) {
  const busy = pending || requests.size >= MAX_REQUESTS || hosted.size >= MAX_HOSTED;
  if (busy) return send({ type: 'answer', sessionId: msg.sessionId, accept: false });
  const { sessionId } = msg;
  requests.set(sessionId, { sessionId, from: msg.from, name: typeof msg.name === 'string' ? msg.name.slice(0, 64) : '' });
  showNextRequest();
  requestSound();
  // With an access password set, the other side may prove it knows it
  // instead of waiting for someone to press "Kabul et".
  api.access.challenge(sessionId).then((challenge) => {
    if (challenge && requests.has(sessionId)) {
      send({ type: 'auth', sessionId, data: { kind: 'challenge', salt: challenge.salt, nonce: challenge.nonce } });
    }
  });
}

function showNextRequest() {
  const next = requests.values().next().value;
  if (!next) return api.request.hide();
  api.request.show({
    sessionId: next.sessionId,
    from: formatId(next.from),
    name: next.name,
    control: prefs.allowControl,
    waiting: requests.size - 1,
    theme: document.documentElement.dataset.theme,
    accent: prefs.accent,
  });
}

function dropRequest(sessionId) {
  if (!requests.delete(sessionId)) return;
  api.access.forget(sessionId);
  showNextRequest();
}

function answerRequest(sessionId, accept) {
  if (!requests.has(sessionId)) return;
  send({ type: 'answer', sessionId, accept: accept === true });
  // An accepted request stays listed until the server confirms with "start".
  if (accept !== true) dropRequest(sessionId);
  else api.request.hide();
}

// --- access password ---------------------------------------------------------
function hidePasswordBox() {
  $('password-box').hidden = true;
  $('password-input').value = '';
}

async function sendProof(key, remember) {
  if (!pending || !pending.challenge) return;
  const { sessionId, challenge } = pending;
  const proof = await api.access.answer(key, challenge.nonce, sessionId);
  if (!proof || !pending || pending.sessionId !== sessionId) return;
  pending.usedKey = remember ? { key, salt: challenge.salt } : null;
  send({ type: 'auth', sessionId, data: { kind: 'proof', proof } });
}

async function onAuth(msg) {
  const data = msg.data;
  if (!data || typeof data !== 'object') return;
  if (pending && pending.sessionId === msg.sessionId) {
    if (data.kind === 'challenge' && HEX32.test(data.salt) && HEX32.test(data.nonce)) {
      pending.challenge = { salt: data.salt, nonce: data.nonce };
      const known = loadPeers().find((p) => p.id === pending.to);
      if (known && known.key && known.salt === data.salt) {
        pending.triedSaved = true;
        return sendProof(known.key, true);
      }
      setMessage('Karşı tarafın onayı bekleniyor…');
      $('password-box').hidden = false;
      $('password-input').focus();
    } else if (data.kind === 'denied') {
      pending.usedKey = null;
      if (pending.triedSaved) {
        // The remembered key no longer matches: the password was changed.
        pending.triedSaved = false;
        updatePeer(pending.to, { key: '', salt: '' });
        setMessage('Kayıtlı parola artık geçerli değil. Parolayı yeniden girin ya da onay bekleyin.');
      } else {
        setMessage('Parola yanlış. Yeniden deneyin ya da onay bekleyin.');
      }
      $('password-box').hidden = false;
      $('password-input').value = '';
      $('password-input').focus();
    }
  } else if (requests.has(msg.sessionId) && data.kind === 'proof') {
    const { sessionId } = msg;
    const ok = await api.access.verify(sessionId, data.proof);
    if (!requests.has(sessionId)) return;
    if (ok) answerRequest(sessionId, true);
    else send({ type: 'auth', sessionId, data: { kind: 'denied' } });
  }
}

// --- WebRTC ------------------------------------------------------------------
function createLink(role, sessionId, peerId, name, iceServers) {
  const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  const link = {
    role,
    sessionId,
    peerId,
    name: name || '',
    pc,
    alive: true,
    channel: null,
    files: null,
    quality: 'balanced',
    hostPlatform: null,
    signals: Promise.resolve(),
    audio: null,
    voice: false,
    ping: null,
    lastPing: 0,
  };
  pc.onicecandidate = (event) => {
    if (event.candidate && link.alive) send({ type: 'signal', sessionId, data: { candidate: event.candidate } });
  };
  pc.addEventListener('track', (event) => {
    if (event.track.kind !== 'audio' || !link.alive) return;
    link.audio = document.createElement('audio');
    link.audio.autoplay = true;
    link.audio.srcObject = new MediaStream([event.track]);
    $('audios').append(link.audio);
  });
  pc.onconnectionstatechange = () => {
    if (!link.alive) return;
    if (pc.connectionState === 'connected' && link === active) $('viewer-state').textContent = link.watchOnly ? 'Yalnızca izleme' : '';
    if (pc.connectionState === 'failed') {
      endLink(link, true);
      if (role === 'viewer') setMessage('Bağlantı kurulamadı. Ağ bu bağlantıya izin vermiyor olabilir.');
    }
  };
  return link;
}

// Signals are applied strictly in arrival order: a candidate must never be
// added before the description it belongs to.
function queueSignal(link, data) {
  link.signals = link.signals.then(() => onSignal(link, data));
}

async function onSignal(link, data) {
  if (!link.alive || !data) return;
  const { pc } = link;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        // Reserve a voice line in both directions; it stays silent until a
        // microphone is switched on.
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.receiver.track.kind === 'audio') {
            transceiver.direction = 'sendrecv';
            if (mic) await transceiver.sender.replaceTrack(mic.getAudioTracks()[0]).catch(() => {});
          }
        }
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'signal', sessionId: link.sessionId, data: { sdp: pc.localDescription } });
        if (link.role === 'host') applyQuality(link, link.quality);
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function applyQuality(link, name) {
  if (link.role !== 'host' || !link.alive) return;
  const preset = Object.hasOwn(QUALITY, name) ? QUALITY[name] : QUALITY.balanced;
  link.quality = Object.hasOwn(QUALITY, name) ? name : 'balanced';
  for (const sender of link.pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    sender.track.contentHint = preset.hint;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) continue;
    params.encodings[0].maxBitrate = preset.maxBitrate;
    params.encodings[0].maxFramerate = preset.maxFramerate;
    params.degradationPreference = 'balanced';
    sender.setParameters(params).catch((err) => console.error('sender params', err));
  }
}

function sendTo(link, msg) {
  if (link.channel && link.channel.readyState === 'open') link.channel.send(JSON.stringify(msg));
}

// To the remote screen on display when viewing; to every connected computer
// when hosting.
function control(msg) {
  for (const link of targets()) sendTo(link, msg);
}

function bindChannel(link, channel) {
  link.channel = channel;
  channel.onopen = () => {
    if (!link.alive) return;
    if (link.role === 'host') {
      if (prefs.allowClipboard) api.syncClipboard(true);
      sendTo(link, { t: 'hello', platform: info.platform, control: prefs.allowControl, name: prefs.name, displays: displayInfo(), display: link.displayId });
      if (mic) sendTo(link, { t: 'voice', on: true });
    } else {
      api.syncClipboard(true);
      sendTo(link, { t: 'quality', value: prefs.quality });
      if (mic && link === active) sendTo(link, { t: 'voice', on: true });
    }
  };
  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!link.alive || !msg) return;
    if (msg.t === 'chat' || msg.t === 'voice') return onPanelMessage(link, msg);
    if (link.role === 'host') {
      if (msg.t === 'clip') {
        if (prefs.allowClipboard) api.writeClipboard(msg.text);
      } else if (msg.t === 'quality') {
        applyQuality(link, msg.value);
      } else if (msg.t === 'display') {
        switchDisplay(link, msg.id);
      } else if (prefs.allowControl) {
        api.input(msg, prefs.cursorName ? linkLabel(link) : '', link.displayId);
      }
    } else if (msg.t === 'clip') {
      // A screen in a background tab does not overwrite this clipboard.
      if (link === active) api.writeClipboard(msg.text);
    } else if (msg.t === 'display') {
      if (typeof msg.id === 'string') link.display = msg.id;
      if (link === active) setViewerState(msg.failed ? 'Bu ekrana geçilemedi.' : link.watchOnly ? 'Yalnızca izleme' : '');
      if (link === active) renderDisplays();
    } else if (msg.t === 'displays') {
      link.displays = cleanDisplays(msg.displays);
      if (typeof msg.display === 'string') link.display = msg.display;
      if (link === active) renderDisplays();
    } else if (msg.t === 'hello') {
      link.hostPlatform = msg.platform;
      link.displays = cleanDisplays(msg.displays);
      link.display = typeof msg.display === 'string' ? msg.display : '';
      if (link === active) renderDisplays();
      link.watchOnly = msg.control === false;
      if (link.watchOnly && link === active) $('viewer-state').textContent = 'Yalnızca izleme';
    }
  };
}

// Pointer moves travel on their own channel that never waits for a lost
// packet: a late position is worthless once a newer one exists.
function bindPointer(link, channel) {
  link.pointer = channel;
  if (link.role !== 'host') return;
  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (link.alive && msg && msg.t === 'm' && prefs.allowControl) api.input(msg, prefs.cursorName ? linkLabel(link) : '', link.displayId);
  };
}

// --- host role ---------------------------------------------------------------
const mainDisplayId = () => (displays[0] ? displays[0].id : '');

// One capture per screen, shared by every connected computer showing it.
function ensureCapture(displayId) {
  let started = captures.get(displayId);
  if (!started) {
    started = { stream: null, promise: null };
    const entry = started;
    // The screen to capture is named just before asking, so requests for
    // different screens must not overlap.
    entry.promise = captureChain = captureChain
      .catch(() => {})
      .then(() => api.wantDisplay(displayId))
      .then(() => navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: CAPTURE_FRAMERATE } }))
      .then((stream) => {
        entry.stream = stream;
        // Everyone left this screen while the capture was starting.
        if (captures.get(displayId) !== entry) for (const track of stream.getTracks()) track.stop();
        return stream;
      })
      .catch((err) => {
        if (captures.get(displayId) === entry) captures.delete(displayId);
        throw err;
      });
    captures.set(displayId, entry);
  }
  return started.promise;
}

// Stops captures of screens nobody is looking at any more.
function stopUnusedCaptures() {
  const used = new Set([...hosted.values()].map((link) => link.displayId));
  for (const [displayId, entry] of [...captures]) {
    if (used.has(displayId)) continue;
    captures.delete(displayId);
    if (entry.stream) for (const track of entry.stream.getTracks()) track.stop();
  }
}

function stopCapture() {
  for (const entry of captures.values()) if (entry.stream) for (const track of entry.stream.getTracks()) track.stop();
  captures.clear();
}

const displayInfo = () =>
  displays.map((d) => ({ id: d.id, number: d.number, primary: d.primary, label: d.label, width: d.width, height: d.height }));

// The viewer asked to see another screen of this computer.
async function switchDisplay(link, displayId) {
  if (typeof displayId !== 'string' || !displays.some((d) => d.id === displayId) || link.displayId === displayId) return;
  const previous = link.displayId;
  try {
    const stream = await ensureCapture(displayId);
    if (!link.alive) return;
    const sender = link.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    await sender.replaceTrack(stream.getVideoTracks()[0]);
    link.displayId = displayId;
    applyQuality(link, link.quality);
    sendTo(link, { t: 'display', id: displayId });
  } catch (err) {
    console.error('display switch failed', err);
    link.displayId = previous;
    sendTo(link, { t: 'display', id: previous, failed: true });
  } finally {
    stopUnusedCaptures();
  }
}

function startHost(msg) {
  const request = requests.get(msg.sessionId);
  dropRequest(msg.sessionId);
  const link = createLink('host', request.sessionId, request.from, request.name, msg.iceServers);
  hosted.set(link.sessionId, link);
  link.displayId = mainDisplayId();
  link.pc.ondatachannel = (event) => {
    if (event.channel.label === 'files') bindFiles(link, event.channel);
    else if (event.channel.label === 'pointer') bindPointer(link, event.channel);
    else bindChannel(link, event.channel);
  };
  // The viewer's offer may arrive first; it waits here until the screen is ready.
  link.signals = ensureCapture(link.displayId)
    .then((stream) => {
      if (link.alive) for (const track of stream.getTracks()) link.pc.addTrack(track, stream);
    })
    .catch((err) => {
      console.error('host start failed', err);
      endLink(link, true);
      refreshPermissions(false);
    });
  api.setHosting(true);
  if (links().length === 1) openPanel(false);
  addBubble('note', `${linkLabel(link)} bağlandı.`);
  renderHosting();
}

function renderHosting() {
  $('hosting-chip').hidden = hosted.size === 0;
  $('hosting-chip').textContent = hosted.size === 1 ? `${linkLabel([...hosted.values()][0])} bu bilgisayara bağlı` : `${hosted.size} kişi bu bilgisayara bağlı`;
  updatePanelTarget();
  const box = $('hosting-list');
  box.replaceChildren();
  $('hosting').hidden = hosted.size === 0;
  $('hosting-stop').hidden = hosted.size < 2;
  for (const link of hosted.values()) {
    const row = document.createElement('div');
    row.className = 'hosting-row';
    const who = document.createElement('span');
    const id = document.createElement('strong');
    id.textContent = formatId(link.peerId);
    who.append(id, link.name ? ` (${link.name}) bağlı` : ' bağlı');
    const ping = document.createElement('span');
    ping.className = 'ping';
    link.pingLabel = ping;
    showPing(link);
    const stop = document.createElement('button');
    stop.className = 'danger small';
    stop.textContent = 'Bağlantıyı kes';
    stop.addEventListener('click', () => endLink(link, true));
    row.append(who, ping, stop);
    box.append(row);
  }
}

// --- viewer role -------------------------------------------------------------
function showView(name) {
  for (const id of ['home', 'settings', 'viewer']) $(id).hidden = id !== name;
  updatePanelTarget();
}

function applyScale(scale) {
  $('stage').dataset.scale = scale;
  $('viewer-scale').value = scale;
}

async function startViewer(msg) {
  const { sessionId, to, usedKey } = pending;
  pending = null;
  hidePasswordBox();
  setMessage('');
  const known = loadPeers().find((p) => p.id === to);
  const link = createLink('viewer', sessionId, to, known ? known.name : '', msg.iceServers);
  views.set(sessionId, link);
  const { pc } = link;
  updatePeer(to, usedKey ? { last: Date.now(), key: usedKey.key, salt: usedKey.salt } : { last: Date.now() });
  bindChannel(link, pc.createDataChannel('control', { ordered: true }));
  bindPointer(link, pc.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 }));
  bindFiles(link, pc.createDataChannel('files', { ordered: true }));
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.addEventListener('track', (event) => {
    if (event.track.kind !== 'video') return;
    // Show each frame as soon as it arrives rather than buffering for smoothness.
    if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
    link.stream = new MediaStream([event.track]);
    if (link === active) $('screen').srcObject = link.stream;
  });
  $('viewer-quality').value = prefs.quality;
  applyScale(prefs.scale);
  if (links().length === 1) openPanel(true);
  else addBubble('note', `${sessionTitle(link)} ile yeni oturum açıldı.`);
  setActive(link, true);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'signal', sessionId, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.error('viewer start failed', err);
    endLink(link, true);
    setMessage('Bağlantı kurulamadı.');
  }
}

// --- the remote computer's screens --------------------------------------------
function cleanDisplays(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, 8)
    .filter((d) => d && typeof d.id === 'string' && d.id.length <= 40)
    .map((d, index) => ({
      id: d.id,
      number: Number.isInteger(d.number) ? d.number : index + 1,
      primary: d.primary === true,
      label: typeof d.label === 'string' ? d.label.slice(0, 60) : '',
      width: Number.isInteger(d.width) ? d.width : 0,
      height: Number.isInteger(d.height) ? d.height : 0,
    }));
}

function setViewerState(text) {
  $('viewer-state').textContent = text;
}

// One button per screen, shown only when the remote computer has more than one.
function renderDisplays() {
  const box = $('display-picker');
  box.replaceChildren();
  const list = active && active.displays ? active.displays : [];
  box.hidden = list.length < 2;
  if (list.length < 2) return;
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = 'Ekran:';
  box.append(label);
  for (const display of list) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small display-button';
    button.textContent = display.primary ? `${display.number} · Ana` : String(display.number);
    const size = display.width && display.height ? ` (${display.width}×${display.height})` : '';
    button.title = `${display.label || `Ekran ${display.number}`}${size}`;
    button.setAttribute('aria-pressed', String(display.id === active.display));
    button.addEventListener('click', () => {
      if (!active || display.id === active.display) return;
      setViewerState('Ekran değiştiriliyor…');
      sendTo(active, { t: 'display', id: display.id });
      $('stage').focus();
    });
    box.append(button);
  }
}

// --- tabs: several remote screens at once ------------------------------------
// Puts a tab's screen on display. Keyboard, mouse, chat, files, voice and the
// clipboard all follow the screen on display; the others keep running.
function setActive(link, show) {
  const previous = active;
  if (previous && previous !== link && previous.alive) {
    sendTo(previous, { t: 'release' });
    const thumb = captureThumb();
    if (thumb) updatePeer(previous.peerId, { thumb });
  }
  if (mic && previous !== link) moveMic(previous && previous.alive ? previous : null, link);
  active = link;
  $('screen').srcObject = link.stream || null;
  const connected = link.pc.connectionState === 'connected';
  setViewerState(connected ? (link.watchOnly ? 'Yalnızca izleme' : '') : 'Bağlanıyor…');
  renderTabs();
  renderDisplays();
  updatePanelTarget();
  showVoiceState();
  if (show) {
    showView('viewer');
    $('stage').focus();
  }
}

async function moveMic(from, to) {
  const track = mic && mic.getAudioTracks()[0];
  if (from) {
    const sender = audioSender(from);
    if (sender) await sender.replaceTrack(null).catch(() => {});
    sendTo(from, { t: 'voice', on: false });
  }
  if (to && track) {
    const sender = audioSender(to);
    if (sender) await sender.replaceTrack(track).catch(() => {});
    sendTo(to, { t: 'voice', on: true });
  }
}

let switchTarget = null;

// Switching asks first, so a stray click never moves the keyboard and mouse
// to a different computer.
function requestSwitch(link) {
  if (!link.alive) return;
  if (link === active) {
    showView('viewer');
    $('stage').focus();
    return;
  }
  if (!prefs.confirmSwitch || !active) {
    setActive(link, true);
    return;
  }
  switchTarget = link;
  $('switch-to').textContent = sessionTitle(link);
  $('switch-from').textContent = sessionTitle(active);
  $('switch-remember').checked = false;
  $('switch-dialog').hidden = false;
  $('switch-confirm').focus();
}

function closeSwitch(confirmed) {
  const link = switchTarget;
  switchTarget = null;
  $('switch-dialog').hidden = true;
  if (!confirmed || !link || !link.alive) {
    if (active && !$('viewer').hidden) $('stage').focus();
    return;
  }
  if ($('switch-remember').checked) {
    prefs.confirmSwitch = false;
    savePrefs();
    $('pref-confirm-switch').checked = false;
  }
  setActive(link, true);
}

function renderTabs() {
  const box = $('tabs');
  box.replaceChildren();
  for (const link of views.values()) {
    const tab = document.createElement('div');
    tab.className = 'session-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(link === active));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'session-open';
    open.title = link === active ? 'Şu an görüntülenen oturum' : 'Bu oturuma geç';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = sessionTitle(link);
    const ping = document.createElement('span');
    ping.className = 'ping';
    link.pingLabel = ping;
    open.append(name, ping);
    open.addEventListener('click', () => requestSwitch(link));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'session-close';
    close.title = 'Bu oturumu kapat';
    close.setAttribute('aria-label', `${sessionTitle(link)} oturumunu kapat`);
    close.innerHTML = ICONS.remove;
    close.addEventListener('click', () => endLink(link, true));
    tab.append(open, close);
    box.append(tab);
    showPing(link);
  }
  $('new-session').disabled = views.size >= MAX_VIEWS;
  renderSessionsBar();
}

// On the home screen, a way back to the sessions still open.
function renderSessionsBar() {
  $('sessions-bar').hidden = views.size === 0;
  if (views.size === 0) return;
  $('sessions-text').textContent =
    views.size === 1 ? `${sessionTitle(active || [...views.values()][0])} ile oturum açık.` : `${views.size} oturum açık.`;
}

// A small picture of the remote screen for the list of known computers.
function captureThumb() {
  const video = $('screen');
  if (!video.videoWidth || !video.videoHeight) return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.round((THUMB_WIDTH * video.videoHeight) / video.videoWidth);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return '';
  }
}

function stopMic() {
  if (mic) for (const track of mic.getTracks()) track.stop();
  mic = null;
  setMicButton(false);
}

function endLink(link, notify) {
  if (!link.alive) return;
  link.alive = false;
  if (notify) send({ type: 'bye', sessionId: link.sessionId });
  if (link.audio) link.audio.remove();
  if (link.role === 'viewer') {
    const wasActive = link === active;
    if (wasActive) {
      const thumb = captureThumb();
      if (thumb) updatePeer(link.peerId, { thumb });
    }
    sendTo(link, { t: 'release' });
    views.delete(link.sessionId);
    if (wasActive) {
      active = null;
      $('screen').srcObject = null;
      const next = [...views.values()].pop();
      if (next) {
        // Another tab takes over; the home or settings screen stays as it is.
        setActive(next, !$('viewer').hidden);
      } else {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        if (!$('viewer').hidden) showView('home');
      }
    }
    renderTabs();
    if (links().length > 0) addBubble('note', `${sessionTitle(link)} oturumu kapandı.`);
  } else {
    hosted.delete(link.sessionId);
    renderHosting();
    stopUnusedCaptures();
    if (hosted.size === 0) {
      // Nobody watches this screen any more, even if this computer still
      // shows someone else's.
      api.setHosting(false);
      stopCapture();
    }
    if (links().length > 0) addBubble('note', `${linkLabel(link)} ayrıldı.`);
  }
  try {
    link.pc.close();
  } catch {}
  if (links().length === 0) {
    // The last connection is gone: release everything a session holds.
    api.syncClipboard(false);
    api.setHosting(false);
    api.files.abort();
    stopCapture();
    stopMic();
    closePanel();
  } else {
    showVoiceState();
    updatePanelTarget();
  }
}

function endActive() {
  if (active) endLink(active, true);
}

function endAllHosted() {
  for (const link of [...hosted.values()]) endLink(link, true);
}

// --- connection quality ------------------------------------------------------
function showPing(link) {
  const stale = performance.now() - link.lastPing > PING_STALE_MS;
  const state = link.pc.connectionState;
  let text = '';
  let level = '';
  if (link.ping === null || state === 'new' || state === 'connecting') {
    // Not measured yet.
  } else if (stale || state === 'disconnected') {
    text = 'Bağlantı zayıf';
    level = 'bad';
  } else {
    text = `${link.ping} ms`;
    level = link.ping >= PING_BAD_MS ? 'bad' : link.ping >= PING_WARN_MS ? 'warn' : 'good';
  }
  const title = link.relayed ? 'Gecikme (aktarma sunucusu üzerinden)' : 'Gecikme (doğrudan bağlantı)';
  const labels = [link.pingLabel];
  if (link === active) labels.push($('viewer-ping'));
  for (const label of labels) {
    if (!label) continue;
    label.textContent = text;
    label.dataset.level = level;
    label.title = title;
  }
}

async function measurePings() {
  for (const link of links()) {
    try {
      const stats = await link.pc.getStats();
      let pair = null;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId) || pair;
      });
      if (!pair) {
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
        });
      }
      if (pair && Number.isFinite(pair.currentRoundTripTime)) {
        link.ping = Math.max(1, Math.round(pair.currentRoundTripTime * 1000));
        link.lastPing = performance.now();
        const local = stats.get(pair.localCandidateId);
        link.relayed = Boolean(local && local.candidateType === 'relay');
      }
    } catch {}
    if (link.alive) showPing(link);
  }
}

// --- session panel: chat, voice, files ----------------------------------------
function clearBadges() {
  $('viewer-panel').classList.remove('badge');
  $('hosting-panel').classList.remove('badge');
}

const imageUrls = [];
function forgetImages() {
  for (const url of imageUrls.splice(0)) URL.revokeObjectURL(url);
}

function openPanel(quiet) {
  forgetImages();
  $('chat-log').replaceChildren();
  $('voice-state').textContent = '';
  setMicButton(false);
  $('panel').hidden = quiet;
  clearBadges();
}

function closePanel() {
  $('panel').hidden = true;
  forgetImages();
  $('audios').replaceChildren();
  clearBadges();
}

function togglePanel() {
  $('panel').hidden = !$('panel').hidden;
  clearBadges();
  if (!$('panel').hidden) $('chat-input').focus();
  else if (active && !$('viewer').hidden) $('stage').focus();
}

function addImage(bubble, blob, onOpen) {
  const url = URL.createObjectURL(blob);
  imageUrls.push(url);
  const img = document.createElement('img');
  img.className = 'chat-image';
  img.alt = 'Görüntü';
  img.src = url;
  if (onOpen) {
    img.title = 'Klasörde göster';
    img.addEventListener('click', onOpen);
  }
  img.addEventListener('load', () => {
    const log = $('chat-log');
    log.scrollTop = log.scrollHeight;
  });
  bubble.insertBefore(img, bubble.body);
}

const isInlineImage = (type, size) => INLINE_IMAGE_TYPES.includes(type) && size <= MAX_INLINE_IMAGE_BYTES;

function addBubble(kind, text, from) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${kind}`;
  if (from) {
    const who = document.createElement('span');
    who.className = 'bubble-from';
    who.textContent = from;
    bubble.append(who);
  }
  const body = document.createElement('span');
  body.textContent = text;
  bubble.append(body);
  bubble.body = body;
  const log = $('chat-log');
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function notifyPanel() {
  if (!$('panel').hidden) return;
  $('viewer-panel').classList.add('badge');
  $('hosting-panel').classList.add('badge');
  // The person at the shared computer may not be looking at this window.
  if (hosted.size > 0) {
    $('panel').hidden = false;
    api.attention();
  }
}

function showVoiceState() {
  const all = links();
  const talking = all.filter((link) => link.voice);
  if (talking.length === 0) $('voice-state').textContent = '';
  else if (all.length === 1) $('voice-state').textContent = 'Karşı tarafın mikrofonu açık.';
  else $('voice-state').textContent = `Mikrofonu açık: ${talking.map(linkLabel).join(', ')}`;
}

// Says where a message typed now will go, since that depends on which screen
// is showing.
function updatePanelTarget() {
  const list = targets();
  let text = '';
  if (list.length > 0 && links().length > 1) {
    text =
      list[0].role === 'viewer'
        ? `Mesajlar ve dosyalar: ${sessionTitle(list[0])}`
        : list.length === 1
          ? `Mesajlar ve dosyalar: bu bilgisayara bağlı ${linkLabel(list[0])}`
          : `Mesajlar ve dosyalar: bu bilgisayara bağlı ${list.length} kişi`;
  }
  $('panel-to').textContent = text;
  $('panel-to').hidden = !text;
}

function onPanelMessage(link, msg) {
  if (msg.t === 'chat' && typeof msg.text === 'string' && msg.text) {
    addBubble('theirs', msg.text.slice(0, MAX_CHAT_CHARS), fromLabel(link));
    messageSound();
    notifyPanel();
  } else if (msg.t === 'voice') {
    link.voice = msg.on === true;
    showVoiceState();
    if (link.voice) notifyPanel();
  }
}

function setMicButton(on) {
  $('mic-toggle').setAttribute('aria-pressed', String(on));
  $('mic-toggle').textContent = on ? 'Mikrofonu kapat' : 'Mikrofonu aç';
}

const audioSender = (link) => {
  const transceiver = link.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
  return transceiver ? transceiver.sender : null;
};

async function toggleMic() {
  if (targets().length === 0) return;
  if (mic) {
    stopMic();
    for (const link of links()) {
      const sender = audioSender(link);
      if (sender) await sender.replaceTrack(null).catch(() => {});
      sendTo(link, { t: 'voice', on: false });
    }
    return;
  }
  try {
    if (!(await api.micAccess())) throw new Error('microphone access denied');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (targets().length === 0 || mic) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    mic = stream;
    for (const link of targets()) {
      const sender = audioSender(link);
      if (sender) await sender.replaceTrack(stream.getAudioTracks()[0]).catch(() => {});
    }
    setMicButton(true);
    control({ t: 'voice', on: true });
  } catch (err) {
    console.error('microphone', err);
    addBubble('note', 'Mikrofon açılamadı. Mikrofon iznini ve bağlı bir mikrofon olduğunu kontrol edin.');
  }
}

// Files travel on their own channel: a header, the bytes in order, then a
// "done" marker. One file at a time in each direction.
function bindFiles(link, channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = FILE_BUFFER_LIMIT / 2;
  const state = { channel, queue: [], sending: false, refused: new Set(), incoming: null, chain: Promise.resolve() };
  link.files = state;
  channel.onmessage = (event) => {
    const data = event.data;
    state.chain = state.chain.then(() => onFileMessage(link, state, data)).catch((err) => console.error('file receive', err));
  };
}

async function onFileMessage(link, state, data) {
  if (typeof data !== 'string') {
    const file = state.incoming;
    if (!file || !file.accepted) return;
    api.files.chunk(file.id, data);
    if (file.parts) file.parts.push(data);
    file.received += data.byteLength;
    const now = performance.now();
    if (now - file.shown > 250) {
      file.shown = now;
      file.bubble.body.textContent = `${file.name} alınıyor… %${Math.floor((file.received / Math.max(1, file.size)) * 100)}`;
    }
    return;
  }
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (!msg || typeof msg.id !== 'string') return;
  if (msg.t === 'file') {
    const refuse = (text) => {
      state.incoming = { id: msg.id, accepted: false };
      state.channel.send(JSON.stringify({ t: 'refused', id: msg.id }));
      addBubble('note', text);
    };
    if (link.role === 'host' && !prefs.allowFiles) return refuse('Dosya gönderimi bu bilgisayarın ayarlarında kapalı.');
    const name = String(msg.name).slice(0, 255);
    const saved = await api.files.begin(msg.id, name, msg.size);
    if (!saved) return refuse(`${name} alınamadı.`);
    const bubble = addBubble('theirs file', `${saved} alınıyor…`, fromLabel(link));
    const image = typeof msg.image === 'string' && isInlineImage(msg.image, msg.size) ? msg.image : '';
    state.incoming = { id: msg.id, accepted: true, name: saved, size: msg.size, received: 0, shown: 0, bubble, image, parts: image ? [] : null };
    notifyPanel();
  } else if (msg.t === 'done') {
    const file = state.incoming;
    state.incoming = null;
    if (!file || file.id !== msg.id || !file.accepted) return;
    const savedPath = await api.files.end(file.id);
    if (!savedPath) {
      file.bubble.body.textContent = `${file.name} alınamadı.`;
      return;
    }
    file.bubble.body.textContent = `${file.name} alındı.`;
    if (file.parts) addImage(file.bubble, new Blob(file.parts, { type: file.image }), () => api.files.reveal(savedPath));
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.textContent = 'Klasörde göster';
    reveal.addEventListener('click', () => api.files.reveal(savedPath));
    file.bubble.append(reveal);
    messageSound();
  } else if (msg.t === 'refused') {
    state.refused.add(msg.id);
  }
}

function queueFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_FILE_BYTES) {
      addBubble('note', `${file.name} çok büyük (en fazla 4 GB).`);
      continue;
    }
    for (const link of targets()) if (link.files) link.files.queue.push(file);
  }
  for (const link of targets()) if (link.files) sendNextFile(link);
}

async function sendNextFile(link) {
  const state = link.files;
  if (state.sending) return;
  state.sending = true;
  const usable = () => link.alive && state.channel.readyState === 'open';
  try {
    while (state.queue.length > 0 && usable()) {
      const file = state.queue.shift();
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const to = links().length > 1 ? ` → ${linkLabel(link)}` : '';
      const bubble = addBubble('mine file', `${file.name}${to} gönderiliyor…`);
      const image = isInlineImage(file.type, file.size) ? file.type : undefined;
      if (image) addImage(bubble, file);
      state.channel.send(JSON.stringify({ t: 'file', id, name: file.name, size: file.size, image }));
      let sent = 0;
      let shown = 0;
      let ok = true;
      while (sent < file.size) {
        if (!usable() || state.refused.has(id)) {
          ok = false;
          break;
        }
        if (state.channel.bufferedAmount > FILE_BUFFER_LIMIT) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1000);
            state.channel.addEventListener(
              'bufferedamountlow',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          continue;
        }
        const chunk = await file.slice(sent, sent + FILE_CHUNK_BYTES).arrayBuffer();
        if (!usable()) {
          ok = false;
          break;
        }
        state.channel.send(chunk);
        sent += chunk.byteLength;
        const now = performance.now();
        if (now - shown > 250) {
          shown = now;
          bubble.body.textContent = `${file.name}${to} gönderiliyor… %${Math.floor((sent / Math.max(1, file.size)) * 100)}`;
        }
      }
      if (ok && !state.refused.has(id) && usable()) {
        state.channel.send(JSON.stringify({ t: 'done', id }));
        bubble.body.textContent = `${file.name}${to} gönderildi.`;
      } else {
        bubble.body.textContent = state.refused.has(id) ? `${file.name}${to} karşı tarafça kabul edilmedi.` : `${file.name}${to} gönderilemedi.`;
      }
    }
  } catch (err) {
    console.error('file send', err);
    addBubble('note', 'Dosya gönderilemedi.');
  } finally {
    state.sending = false;
  }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

// A picture of the screen on display: the remote screen when viewing one,
// otherwise this computer's own screen as the connected people see it.
async function sendScreenshot() {
  if (targets().length === 0) return;
  let video = null;
  let temp = null;
  try {
    if (viewingNow() && $('screen').videoWidth) {
      video = $('screen');
    } else if ([...captures.values()].some((entry) => entry.stream)) {
      temp = document.createElement('video');
      temp.muted = true;
      temp.srcObject = [...captures.values()].find((entry) => entry.stream).stream;
      await temp.play().catch(() => {});
      if (!temp.videoWidth) await new Promise((resolve) => temp.addEventListener('loadeddata', resolve, { once: true }));
      video = temp;
    }
    if (!video || !video.videoWidth) throw new Error('no picture');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('encode failed');
    queueFiles([new File([blob], `Ekran-goruntusu-${stamp()}.png`, { type: 'image/png' })]);
  } catch (err) {
    console.error('screenshot', err);
    addBubble('note', 'Ekran görüntüsü alınamadı.');
  } finally {
    if (temp) temp.srcObject = null;
  }
}

// Files dropped or pasted by the user. Folders cannot be sent.
function sendGivenFiles(files, items) {
  const list = [];
  let skippedFolder = false;
  files.forEach((file, index) => {
    const entry = items && items[index] && items[index].webkitGetAsEntry ? items[index].webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) skippedFolder = true;
    else list.push(file);
  });
  if (skippedFolder) addBubble('note', 'Klasörler gönderilemez; klasörün içindeki dosyaları seçip bırakın.');
  if (list.length === 0) return;
  if (targets().length === 0) {
    addBubble('note', 'Dosya göndermek için açık bir bağlantı olmalı.');
    return;
  }
  if ($('panel').hidden) togglePanel();
  queueFiles(list);
}

function setupDropZones() {
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  // A file dropped anywhere else must not replace the app's page.
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => event.preventDefault());
  for (const zone of [$('panel'), $('stage')]) {
    let depth = 0;
    zone.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) || targets().length === 0) return;
      depth += 1;
      zone.classList.add('drop-active');
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) zone.classList.remove('drop-active');
    });
    zone.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = targets().length > 0 ? 'copy' : 'none';
    });
    zone.addEventListener('drop', (event) => {
      depth = 0;
      zone.classList.remove('drop-active');
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      sendGivenFiles([...event.dataTransfer.files], [...event.dataTransfer.items].filter((item) => item.kind === 'file'));
    });
  }
}

function setupPanel() {
  setupDropZones();
  const pasteKey = info.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
  $('panel-hint').textContent = `Dosyaları buraya sürükleyip bırakabilir, kopyaladığınız ekran görüntüsünü ${pasteKey} ile yapıştırabilirsiniz.`;
  $('screenshot-send').addEventListener('click', sendScreenshot);
  // A picture on the clipboard, such as a screenshot, is sent as an image.
  $('chat-input').addEventListener('paste', (event) => {
    const images = [...(event.clipboardData ? event.clipboardData.items : [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (images.length === 0) return;
    event.preventDefault();
    const files = images.map((file) => {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([file], `Ekran-goruntusu-${stamp()}.${ext}`, { type: file.type });
    });
    sendGivenFiles(files, null);
  });
  $('viewer-panel').addEventListener('click', togglePanel);
  $('hosting-panel').addEventListener('click', togglePanel);
  $('panel-close').addEventListener('click', togglePanel);
  $('mic-toggle').addEventListener('click', toggleMic);
  $('file-send').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (event) => {
    queueFiles([...event.target.files]);
    event.target.value = '';
  });
  $('chat-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('chat-input').value.trim().slice(0, MAX_CHAT_CHARS);
    if (!text || !targets().some((link) => link.channel && link.channel.readyState === 'open')) return;
    control({ t: 'chat', text });
    addBubble('mine', text);
    $('chat-input').value = '';
  });
}

// --- viewer input capture ----------------------------------------------------
// Position inside the remote picture as 0..1, or null in the letterbox bars.
function pointerPosition(event) {
  const video = $('screen');
  if (!video.videoWidth || !video.videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function setupViewerInput() {
  const video = $('screen');
  let lastMove = 0;
  let queued = null;
  let moveTimer = null;

  const flushMove = () => {
    moveTimer = null;
    if (!queued || !active) return;
    const msg = JSON.stringify({ t: 'm', x: queued.x, y: queued.y });
    queued = null;
    lastMove = performance.now();
    const pointer = active.pointer;
    if (pointer && pointer.readyState === 'open') pointer.send(msg);
    else if (active.channel && active.channel.readyState === 'open') active.channel.send(msg);
  };

  const onMove = (event) => {
    if (!active) return;
    const pos = pointerPosition(event);
    if (!pos) return;
    queued = pos;
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastMove);
    if (wait <= 0) flushMove();
    else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
  };
  // The raw event arrives as soon as the mouse reports, without waiting for
  // the next screen refresh.
  video.addEventListener('onpointerrawupdate' in video ? 'pointerrawupdate' : 'mousemove', onMove);

  const button = (type) => (event) => {
    if (!active || event.button > 2) return;
    event.preventDefault();
    $('stage').focus({ preventScroll: true });
    const pos = pointerPosition(event);
    if (!pos) return;
    queued = null;
    sendTo(active, { t: type, b: event.button, x: pos.x, y: pos.y });
  };
  video.addEventListener('mousedown', button('d'));
  video.addEventListener('mouseup', button('u'));
  video.addEventListener('contextmenu', (event) => event.preventDefault());
  video.addEventListener(
    'wheel',
    (event) => {
      if (!active) return;
      event.preventDefault();
      sendTo(active, { t: 'w', dx: event.deltaX, dy: event.deltaY });
    },
    { passive: false },
  );

  // Ctrl on a Windows keyboard and Cmd on a Mac keyboard do the same job, so
  // the main shortcut key is translated when the two sides differ.
  const translateCode = (code) => {
    const hostIsMac = active.hostPlatform === 'darwin';
    const viewerIsMac = info.platform === 'darwin';
    if (viewerIsMac && !hostIsMac && code.startsWith('Meta')) return 'ControlLeft';
    if (!viewerIsMac && hostIsMac && code.startsWith('Control')) return 'MetaLeft';
    return code;
  };

  const key = (down) => (event) => {
    // Keys typed into FarDesk's own controls, or pressed while the remote
    // screen is not on display, stay local.
    if (!active || $('viewer').hidden || !$('switch-dialog').hidden) return;
    if (event.target instanceof Element && event.target.closest('.toolbar, #panel')) return;
    event.preventDefault();
    const plainText = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    if (plainText) {
      if (down) sendTo(active, { t: 't', ch: event.key });
      return;
    }
    sendTo(active, { t: 'k', code: translateCode(event.code), down });
  };
  window.addEventListener('keydown', key(true), true);
  window.addEventListener('keyup', key(false), true);
  window.addEventListener('blur', () => {
    if (active) sendTo(active, { t: 'release' });
  });

  $('viewer-quality').addEventListener('change', (event) => {
    prefs.quality = event.target.value;
    savePrefs();
    $('pref-quality').value = prefs.quality;
    // The picture setting applies to every open screen.
    for (const link of views.values()) sendTo(link, { t: 'quality', value: prefs.quality });
    $('stage').focus();
  });
  $('viewer-scale').addEventListener('change', (event) => {
    prefs.scale = event.target.value;
    savePrefs();
    $('pref-scale').value = prefs.scale;
    applyScale(prefs.scale);
    $('stage').focus();
  });
}

// --- settings ----------------------------------------------------------------
function setupSettings() {
  $('pref-name').value = prefs.name;
  $('pref-theme').value = prefs.theme;
  $('pref-quality').value = prefs.quality;
  $('pref-scale').value = prefs.scale;
  $('pref-control').checked = prefs.allowControl;
  $('pref-clipboard').checked = prefs.allowClipboard;
  $('pref-files').checked = prefs.allowFiles;

  const bind = (id, event, apply) =>
    $(id).addEventListener(event, (e) => {
      apply(e.target);
      savePrefs();
    });
  bind('pref-name', 'change', (el) => {
    prefs.name = el.value.trim().slice(0, 40) || info.name;
    el.value = prefs.name;
  });
  bind('pref-theme', 'change', (el) => {
    prefs.theme = el.value;
    applyTheme();
  });
  bind('pref-quality', 'change', (el) => {
    prefs.quality = el.value;
  });
  bind('pref-scale', 'change', (el) => {
    prefs.scale = el.value;
  });
  bind('pref-control', 'change', (el) => {
    prefs.allowControl = el.checked;
  });
  bind('pref-clipboard', 'change', (el) => {
    prefs.allowClipboard = el.checked;
  });
  bind('pref-files', 'change', (el) => {
    prefs.allowFiles = el.checked;
  });
  $('pref-confirm-switch').checked = prefs.confirmSwitch;
  bind('pref-confirm-switch', 'change', (el) => {
    prefs.confirmSwitch = el.checked;
  });
  $('pref-sounds').checked = prefs.sounds;
  bind('pref-sounds', 'change', (el) => {
    prefs.sounds = el.checked;
  });
  $('pref-cursor-name').checked = prefs.cursorName;
  bind('pref-cursor-name', 'change', (el) => {
    prefs.cursorName = el.checked;
  });
  $('pref-background').checked = prefs.background;
  api.setBackground(prefs.background);
  bind('pref-background', 'change', (el) => {
    prefs.background = el.checked;
    api.setBackground(prefs.background);
  });
  api.autostart().then((enabled) => {
    $('pref-autostart').checked = enabled;
  });
  $('pref-autostart').addEventListener('change', async (event) => {
    event.target.checked = await api.autostart(event.target.checked);
  });
  for (const swatch of document.querySelectorAll('.swatch')) {
    swatch.addEventListener('click', () => {
      prefs.accent = swatch.dataset.accent;
      savePrefs();
      applyTheme();
    });
  }
  darkQuery.addEventListener('change', applyTheme);

  const showAccess = async (note) => {
    const status = await api.access.status();
    $('access-status').textContent = note || (status.enabled ? 'Parola ayarlı: parolayı bilen kişi onay beklemeden bağlanabilir.' : 'Parola ayarlı değil: her bağlantı için onayınız gerekir.');
    $('access-clear').disabled = !status.enabled;
  };
  $('access-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const ok = await api.access.set($('access-password').value);
    $('access-password').value = '';
    showAccess(ok ? 'Parola kaydedildi.' : 'Parola en az 8 karakter olmalı.');
  });
  $('access-clear').addEventListener('click', async () => {
    await api.access.clear();
    showAccess('Parola kaldırıldı.');
  });
  showAccess();

  for (const item of document.querySelectorAll('.side-item')) {
    item.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.side-item')) other.removeAttribute('aria-current');
      item.setAttribute('aria-current', 'page');
      for (const page of document.querySelectorAll('.page')) page.hidden = page.dataset.page !== item.dataset.page;
    });
  }
  $('open-settings').addEventListener('click', () => showView('settings'));
  $('close-settings').addEventListener('click', () => showView('home'));

  $('check-update').addEventListener('click', async () => {
    $('check-update-result').textContent = 'Denetleniyor…';
    const result = await api.checkUpdate();
    const texts = {
      current: 'En güncel sürümü kullanıyorsunuz.',
      available: `Yeni sürüm bulundu: ${result.version}`,
      unavailable: 'Güncelleme denetimi yalnızca kurulu sürümde çalışır.',
      error: 'Güncelleme denetlenemedi. İnternet bağlantınızı kontrol edin.',
    };
    $('check-update-result').textContent = texts[result.state] || texts.error;
  });
}

// --- permissions (macOS) and updates -----------------------------------------
async function refreshPermissions(prompt) {
  const state = await api.permissions(prompt);
  const missing = !state.screen ? 'screen' : !state.control ? 'control' : null;
  $('permissions').hidden = !missing;
  if (!missing) return;
  $('permissions-text').textContent =
    missing === 'screen'
      ? 'Bu bilgisayara bağlanılabilmesi için Ekran Kaydı izni gerekli.'
      : 'Bu bilgisayarın uzaktan kontrol edilebilmesi için Erişilebilirlik izni gerekli.';
  $('permissions-button').onclick = () => api.openSettings(missing);
}

function setupUpdates() {
  api.onUpdate((status) => {
    $('update').hidden = false;
    if (status.state === 'ready') {
      $('update-text').textContent = `Yeni sürüm ${status.version} indirildi.`;
      $('update-button').textContent = 'Yeniden başlat ve güncelle';
    } else {
      $('update-text').textContent = `Yeni sürüm ${status.version} yayınlandı.`;
      $('update-button').textContent = 'İndirme sayfasını aç';
    }
  });
  $('update-button').addEventListener('click', () => api.installUpdate());
}

// --- wiring ------------------------------------------------------------------
async function main() {
  info = await api.info();
  prefs = loadPrefs();
  applyTheme();
  $('version').textContent = info.version;

  $('remote-id').addEventListener('input', (event) => {
    event.target.value = formatId(digits(event.target.value));
    setMessage('');
    $('connect-button').disabled = !myId || digits(event.target.value).length !== 9;
  });
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    connectTo(digits($('remote-id').value));
  });
  $('copy-id').addEventListener('click', () => {
    if (myId) api.writeClipboard(myId);
  });
  api.request.onAnswer((answer) => {
    if (answer && typeof answer.sessionId === 'string') answerRequest(answer.sessionId, answer.accept === true);
  });
  $('password-box').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!pending || !pending.challenge) return;
    const password = $('password-input').value;
    if (!password) return;
    const { sessionId, challenge } = pending;
    $('password-box').hidden = true;
    setMessage('Parola denetleniyor…');
    const key = await api.access.derive(password, challenge.salt);
    if (key && pending && pending.sessionId === sessionId) sendProof(key, $('password-remember').checked);
  });
  setupPanel();
  $('hosting-stop').addEventListener('click', endAllHosted);
  $('hosting-chip').addEventListener('click', () => showView('home'));
  $('viewer-stop').addEventListener('click', endActive);
  $('new-session').addEventListener('click', () => {
    showView('home');
    $('remote-id').value = '';
    $('remote-id').dispatchEvent(new Event('input', { bubbles: true }));
    $('remote-id').focus();
  });
  $('sessions-return').addEventListener('click', () => {
    if (active) requestSwitch(active);
  });
  $('switch-confirm').addEventListener('click', () => closeSwitch(true));
  $('switch-cancel').addEventListener('click', () => closeSwitch(false));
  $('switch-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSwitch(false);
  });
  $('viewer-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('viewer').requestFullscreen().catch(() => {});
    $('stage').focus();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const other of document.querySelectorAll('.tab')) other.setAttribute('aria-selected', String(other === tab));
      renderPeers();
    });
  }

  api.onClipboard((text) => {
    for (const link of targets()) if (link.role === 'viewer' || prefs.allowClipboard) sendTo(link, { t: 'clip', text });
  });
  displays = await api.displays();
  api.onDisplays((list) => {
    displays = Array.isArray(list) ? list : [];
    for (const link of hosted.values()) {
      // A screen that went away: fall back to the main screen.
      if (!displays.some((d) => d.id === link.displayId) && displays[0]) {
        link.displayId = '';
        switchDisplay(link, displays[0].id);
      }
      sendTo(link, { t: 'displays', displays: displayInfo(), display: link.displayId });
    }
  });
  setInterval(measurePings, PING_INTERVAL_MS);
  setupViewerInput();
  setupSettings();
  setupUpdates();
  renderPeers();
  refreshPermissions(false);
  window.addEventListener('focus', () => refreshPermissions(false));
  connectServer();
}

main();
