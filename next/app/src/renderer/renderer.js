'use strict';
// UI, signaling and WebRTC for both roles: "host" (this screen is shared and
// controlled) and "viewer" (this window shows and controls a remote screen).

const $ = (id) => document.getElementById(id);
const api = window.fardesk;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const RECONNECT_MS = 3000;
const MOVE_INTERVAL_MS = 8;
const PEERS_KEY = 'fardesk.peers';
const PREFS_KEY = 'fardesk.prefs';
const ACCENTS = ['green', 'blue', 'purple', 'orange', 'red', 'slate'];
const MAX_CHAT_CHARS = 2000;
const FILE_CHUNK_BYTES = 64 * 1024;
const FILE_BUFFER_LIMIT = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PEERS = 24;
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
let pending = null; // viewer waiting for an answer: { sessionId, to }
let incoming = null; // host deciding on a request: { sessionId, from }
let session = null; // { role, sessionId, peerId, pc, channel, stream, hostPlatform }
let starting = null; // host preparing its screen: { sessionId, signals }
let signalChain = Promise.resolve();
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

function connectTo(id) {
  if (id.length !== 9 || pending || session || !myId) return;
  $('remote-id').value = formatId(id);
  setMessage('Bağlanıyor…');
  send({ type: 'connect', to: id, name: prefs.name });
}

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
    if (incoming) closeRequest();
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
      if (incoming && incoming.sessionId === msg.sessionId) startHost(msg);
      break;
    case 'signal':
      if (session && session.sessionId === msg.sessionId) queueSignal(msg.data);
      else if (starting && starting.sessionId === msg.sessionId) starting.signals.push(msg.data);
      break;
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
  if (incoming && incoming.sessionId === msg.sessionId) closeRequest();
  if (starting && starting.sessionId === msg.sessionId) starting = null;
  if (session && session.sessionId === msg.sessionId) {
    const wasViewer = session.role === 'viewer';
    endSession(false);
    if (wasViewer) setMessage(END_REASONS[msg.reason] || 'Bağlantı sonlandı.');
  }
}

// --- incoming request (host side) --------------------------------------------
function onIncoming(msg) {
  // One session at a time; a second request is declined automatically.
  if (session || incoming || pending) return send({ type: 'answer', sessionId: msg.sessionId, accept: false });
  incoming = { sessionId: msg.sessionId, from: msg.from };
  $('request-from').textContent = formatId(msg.from);
  $('request-name').textContent = msg.name ? `(${msg.name})` : '';
  $('request-what').textContent = prefs.allowControl
    ? 'bu bilgisayarın ekranını görmek ve kontrol etmek istiyor.'
    : 'bu bilgisayarın ekranını görmek istiyor.';
  $('request').hidden = false;
  $('request-reject').focus();
  // With an access password set, the other side may prove it knows it
  // instead of waiting for someone to press "Kabul et".
  const { sessionId } = incoming;
  api.access.challenge(sessionId).then((challenge) => {
    if (challenge && incoming && incoming.sessionId === sessionId) {
      send({ type: 'auth', sessionId, data: { kind: 'challenge', salt: challenge.salt, nonce: challenge.nonce } });
    }
  });
}

function closeRequest() {
  if (incoming) api.access.forget(incoming.sessionId);
  incoming = null;
  $('request').hidden = true;
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
  } else if (incoming && incoming.sessionId === msg.sessionId && data.kind === 'proof') {
    const { sessionId } = incoming;
    const ok = await api.access.verify(sessionId, data.proof);
    if (!incoming || incoming.sessionId !== sessionId) return;
    if (ok) {
      $('request').hidden = true;
      send({ type: 'answer', sessionId, accept: true });
    } else {
      send({ type: 'auth', sessionId, data: { kind: 'denied' } });
    }
  }
}

// --- WebRTC ------------------------------------------------------------------
function createPeer(iceServers) {
  const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  pc.onicecandidate = (event) => {
    if (event.candidate && session) send({ type: 'signal', sessionId: session.sessionId, data: { candidate: event.candidate } });
  };
  pc.addEventListener('track', (event) => {
    if (event.track.kind === 'audio') $('remote-audio').srcObject = new MediaStream([event.track]);
  });
  pc.onconnectionstatechange = () => {
    if (!session || session.pc !== pc) return;
    if (pc.connectionState === 'connected' && session.role === 'viewer') $('viewer-state').textContent = '';
    if (pc.connectionState === 'failed') {
      const wasViewer = session.role === 'viewer';
      endSession(true);
      if (wasViewer) setMessage('Bağlantı kurulamadı. Ağ bu bağlantıya izin vermiyor olabilir.');
    }
  };
  return pc;
}

// Signals are applied strictly in arrival order: a candidate must never be
// added before the description it belongs to.
function queueSignal(data) {
  signalChain = signalChain.then(() => onSignal(data));
}

async function onSignal(data) {
  if (!session || !data) return;
  const { pc } = session;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        // Reserve a voice line in both directions; it stays silent until a
        // microphone is switched on.
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.receiver.track.kind === 'audio') transceiver.direction = 'sendrecv';
        }
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: 'signal', sessionId: session.sessionId, data: { sdp: pc.localDescription } });
        if (session.role === 'host') applyQuality(session.quality);
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function applyQuality(name) {
  if (!session || session.role !== 'host') return;
  const preset = Object.hasOwn(QUALITY, name) ? QUALITY[name] : QUALITY.balanced;
  session.quality = Object.hasOwn(QUALITY, name) ? name : 'balanced';
  for (const sender of session.pc.getSenders()) {
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

function bindChannel(channel) {
  session.channel = channel;
  channel.onopen = () => {
    if (!session) return;
    if (session.role === 'host') {
      if (prefs.allowClipboard) api.syncClipboard(true);
      channel.send(JSON.stringify({ t: 'hello', platform: info.platform, control: prefs.allowControl }));
    } else {
      api.syncClipboard(true);
      channel.send(JSON.stringify({ t: 'quality', value: prefs.quality }));
    }
  };
  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!session || !msg) return;
    if (session.role === 'host') {
      if (msg.t === 'clip') {
        if (prefs.allowClipboard) api.writeClipboard(msg.text);
      } else if (msg.t === 'quality') {
        applyQuality(msg.value);
      } else if (msg.t === 'chat' || msg.t === 'voice') {
        onPanelMessage(msg);
      } else if (prefs.allowControl) {
        api.input(msg);
      }
    } else if (msg.t === 'clip') {
      api.writeClipboard(msg.text);
    } else if (msg.t === 'chat' || msg.t === 'voice') {
      onPanelMessage(msg);
    } else if (msg.t === 'hello') {
      session.hostPlatform = msg.platform;
      if (msg.control === false) $('viewer-state').textContent = 'Yalnızca izleme';
    }
  };
}

function control(msg) {
  const channel = session && session.channel;
  if (channel && channel.readyState === 'open') channel.send(JSON.stringify(msg));
}

// --- host role ---------------------------------------------------------------
async function startHost(msg) {
  const { sessionId, from } = incoming;
  closeRequest();
  // The viewer's offer can arrive while the screen capture is still starting.
  starting = { sessionId, signals: [] };
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: CAPTURE_FRAMERATE },
    });
    if (!starting || starting.sessionId !== sessionId) {
      // The request was cancelled while the capture was starting.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const pc = createPeer(msg.iceServers);
    session = { role: 'host', sessionId, peerId: from, pc, channel: null, stream, quality: 'balanced' };
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.ondatachannel = (event) => {
      if (event.channel.label === 'files') bindFiles(event.channel);
      else bindChannel(event.channel);
    };
    api.setHosting(true);
    $('hosting-peer').textContent = formatId(from);
    $('hosting').hidden = false;
    openPanel(formatId(from), false);
    const early = starting.signals;
    starting = null;
    for (const data of early) queueSignal(data);
  } catch (err) {
    console.error('host start failed', err);
    starting = null;
    if (session && session.sessionId === sessionId) endSession(true);
    else send({ type: 'bye', sessionId });
    refreshPermissions(false);
  }
}

// --- viewer role -------------------------------------------------------------
function showView(name) {
  for (const view of ['home', 'settings', 'viewer']) $(view).hidden = view !== name;
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
  const pc = createPeer(msg.iceServers);
  session = { role: 'viewer', sessionId, peerId: to, pc, channel: null, stream: null, hostPlatform: null };
  updatePeer(to, usedKey ? { last: Date.now(), key: usedKey.key, salt: usedKey.salt } : { last: Date.now() });
  bindChannel(pc.createDataChannel('control', { ordered: true }));
  bindFiles(pc.createDataChannel('files', { ordered: true }));
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  pc.ontrack = (event) => {
    // Show each frame as soon as it arrives rather than buffering for smoothness.
    if (event.track.kind !== 'video') return;
    if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
    $('screen').srcObject = new MediaStream([event.track]);
  };
  const known = loadPeers().find((p) => p.id === to);
  $('viewer-title').textContent = known && known.name ? `${known.name} · ${formatId(to)}` : formatId(to);
  $('viewer-state').textContent = 'Bağlanıyor…';
  $('viewer-quality').value = prefs.quality;
  applyScale(prefs.scale);
  openPanel($('viewer-title').textContent, true);
  showView('viewer');
  $('stage').focus();
  try {
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'signal', sessionId, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.error('viewer start failed', err);
    endSession(true);
    setMessage('Bağlantı kurulamadı.');
  }
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

function endSession(notify) {
  if (!session) return;
  const ended = session;
  if (ended.role === 'viewer') {
    const thumb = captureThumb();
    if (thumb) updatePeer(ended.peerId, { thumb });
  }
  session = null;
  if (notify) send({ type: 'bye', sessionId: ended.sessionId });
  api.syncClipboard(false);
  if (ended.mic) for (const track of ended.mic.getTracks()) track.stop();
  api.files.abort();
  closePanel();
  if (ended.role === 'host') {
    api.setHosting(false);
    $('hosting').hidden = true;
    if (ended.stream) for (const track of ended.stream.getTracks()) track.stop();
  } else {
    if (ended.channel && ended.channel.readyState === 'open') ended.channel.send(JSON.stringify({ t: 'release' }));
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('screen').srcObject = null;
    showView('home');
  }
  try {
    ended.pc.close();
  } catch {}
}

// --- session panel: chat, voice, files ----------------------------------------
function openPanel(title, quiet) {
  $('panel-title').textContent = title;
  $('chat-log').replaceChildren();
  $('voice-state').textContent = '';
  setMicButton(false);
  $('panel').hidden = quiet;
  $('viewer-panel').classList.remove('badge');
  $('hosting-panel').classList.remove('badge');
}

function closePanel() {
  $('panel').hidden = true;
  $('remote-audio').srcObject = null;
  $('viewer-panel').classList.remove('badge');
  $('hosting-panel').classList.remove('badge');
}

function togglePanel() {
  $('panel').hidden = !$('panel').hidden;
  $('viewer-panel').classList.remove('badge');
  $('hosting-panel').classList.remove('badge');
  if (!$('panel').hidden) $('chat-input').focus();
  else if (viewing()) $('stage').focus();
}

function addBubble(kind, text) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${kind}`;
  bubble.textContent = text;
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
  if (session && session.role === 'host') {
    $('panel').hidden = false;
    api.attention();
  }
}

function onPanelMessage(msg) {
  if (msg.t === 'chat' && typeof msg.text === 'string' && msg.text) {
    addBubble('theirs', msg.text.slice(0, MAX_CHAT_CHARS));
    notifyPanel();
  } else if (msg.t === 'voice') {
    $('voice-state').textContent = msg.on === true ? 'Karşı tarafın mikrofonu açık.' : '';
    if (msg.on === true) notifyPanel();
  }
}

function setMicButton(on) {
  $('mic-toggle').setAttribute('aria-pressed', String(on));
  $('mic-toggle').textContent = on ? 'Mikrofonu kapat' : 'Mikrofonu aç';
}

async function toggleMic() {
  if (!session) return;
  const current = session;
  const audio = current.pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio');
  if (!audio) return addBubble('note', 'Bu oturumda sesli görüşme kullanılamıyor.');
  if (current.mic) {
    for (const track of current.mic.getTracks()) track.stop();
    current.mic = null;
    await audio.sender.replaceTrack(null).catch(() => {});
    setMicButton(false);
    control({ t: 'voice', on: false });
    return;
  }
  try {
    if (!(await api.micAccess())) throw new Error('microphone access denied');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (session !== current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    await audio.sender.replaceTrack(stream.getAudioTracks()[0]);
    current.mic = stream;
    setMicButton(true);
    control({ t: 'voice', on: true });
  } catch (err) {
    console.error('microphone', err);
    addBubble('note', 'Mikrofon açılamadı. Mikrofon iznini ve bağlı bir mikrofon olduğunu kontrol edin.');
  }
}

// Files travel on their own channel: a header, the bytes in order, then a
// "done" marker. One file at a time in each direction.
function bindFiles(channel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = FILE_BUFFER_LIMIT / 2;
  session.files = { channel, queue: [], sending: false, refused: new Set(), incoming: null, chain: Promise.resolve() };
  const state = session.files;
  channel.onmessage = (event) => {
    const data = event.data;
    state.chain = state.chain.then(() => onFileMessage(state, data)).catch((err) => console.error('file receive', err));
  };
}

async function onFileMessage(state, data) {
  if (typeof data !== 'string') {
    const file = state.incoming;
    if (!file || !file.accepted) return;
    api.files.chunk(file.id, data);
    file.received += data.byteLength;
    const now = performance.now();
    if (now - file.shown > 250) {
      file.shown = now;
      file.label.textContent = `${file.name} alınıyor… %${Math.floor((file.received / Math.max(1, file.size)) * 100)}`;
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
    if (session && session.role === 'host' && !prefs.allowFiles) return refuse('Dosya gönderimi bu bilgisayarın ayarlarında kapalı.');
    const name = String(msg.name).slice(0, 255);
    const saved = await api.files.begin(msg.id, name, msg.size);
    if (!saved) return refuse(`${name} alınamadı.`);
    const bubble = addBubble('theirs file', '');
    const label = document.createElement('span');
    label.textContent = `${saved} alınıyor…`;
    bubble.append(label);
    state.incoming = { id: msg.id, accepted: true, name: saved, size: msg.size, received: 0, shown: 0, bubble, label };
    notifyPanel();
  } else if (msg.t === 'done') {
    const file = state.incoming;
    state.incoming = null;
    if (!file || file.id !== msg.id || !file.accepted) return;
    const savedPath = await api.files.end(file.id);
    if (!savedPath) {
      file.label.textContent = `${file.name} alınamadı.`;
      return;
    }
    file.label.textContent = `${file.name} alındı.`;
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.textContent = 'Klasörde göster';
    reveal.addEventListener('click', () => api.files.reveal(savedPath));
    file.bubble.append(reveal);
  } else if (msg.t === 'refused') {
    state.refused.add(msg.id);
  }
}

function queueFiles(fileList) {
  if (!session || !session.files) return;
  for (const file of fileList) {
    if (file.size > MAX_FILE_BYTES) addBubble('note', `${file.name} çok büyük (en fazla 4 GB).`);
    else session.files.queue.push(file);
  }
  sendNextFile(session);
}

async function sendNextFile(owner) {
  const state = owner.files;
  if (state.sending) return;
  state.sending = true;
  try {
    while (state.queue.length > 0 && session === owner && state.channel.readyState === 'open') {
      const file = state.queue.shift();
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const bubble = addBubble('mine file', `${file.name} gönderiliyor…`);
      state.channel.send(JSON.stringify({ t: 'file', id, name: file.name, size: file.size }));
      let sent = 0;
      let shown = 0;
      let ok = true;
      while (sent < file.size) {
        if (session !== owner || state.channel.readyState !== 'open' || state.refused.has(id)) {
          ok = false;
          break;
        }
        if (state.channel.bufferedAmount > FILE_BUFFER_LIMIT) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1000);
            state.channel.addEventListener('bufferedamountlow', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          continue;
        }
        const chunk = await file.slice(sent, sent + FILE_CHUNK_BYTES).arrayBuffer();
        state.channel.send(chunk);
        sent += chunk.byteLength;
        const now = performance.now();
        if (now - shown > 250) {
          shown = now;
          bubble.textContent = `${file.name} gönderiliyor… %${Math.floor((sent / Math.max(1, file.size)) * 100)}`;
        }
      }
      if (ok && !state.refused.has(id) && state.channel.readyState === 'open') {
        state.channel.send(JSON.stringify({ t: 'done', id }));
        bubble.textContent = `${file.name} gönderildi.`;
      } else {
        bubble.textContent = state.refused.has(id) ? `${file.name} karşı tarafça kabul edilmedi.` : `${file.name} gönderilemedi.`;
      }
    }
  } catch (err) {
    console.error('file send', err);
    addBubble('note', 'Dosya gönderilemedi.');
  } finally {
    state.sending = false;
  }
}

function setupPanel() {
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
    if (!text || !session || !session.channel || session.channel.readyState !== 'open') return;
    control({ t: 'chat', text });
    addBubble('mine', text);
    $('chat-input').value = '';
  });
}

// --- viewer input capture ----------------------------------------------------
const viewing = () => session && session.role === 'viewer';

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
    if (!queued || !viewing()) return;
    control({ t: 'm', x: queued.x, y: queued.y });
    queued = null;
    lastMove = performance.now();
  };

  video.addEventListener('mousemove', (event) => {
    if (!viewing()) return;
    const pos = pointerPosition(event);
    if (!pos) return;
    queued = pos;
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastMove);
    if (wait <= 0) flushMove();
    else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
  });

  const button = (type) => (event) => {
    if (!viewing() || event.button > 2) return;
    event.preventDefault();
    $('stage').focus({ preventScroll: true });
    const pos = pointerPosition(event);
    if (!pos) return;
    queued = null;
    control({ t: type, b: event.button, x: pos.x, y: pos.y });
  };
  video.addEventListener('mousedown', button('d'));
  video.addEventListener('mouseup', button('u'));
  video.addEventListener('contextmenu', (event) => event.preventDefault());
  video.addEventListener(
    'wheel',
    (event) => {
      if (!viewing()) return;
      event.preventDefault();
      control({ t: 'w', dx: event.deltaX, dy: event.deltaY });
    },
    { passive: false },
  );

  // Ctrl on a Windows keyboard and Cmd on a Mac keyboard do the same job, so
  // the main shortcut key is translated when the two sides differ.
  const translateCode = (code) => {
    const hostIsMac = session.hostPlatform === 'darwin';
    const viewerIsMac = info.platform === 'darwin';
    if (viewerIsMac && !hostIsMac && code.startsWith('Meta')) return 'ControlLeft';
    if (!viewerIsMac && hostIsMac && code.startsWith('Control')) return 'MetaLeft';
    return code;
  };

  const key = (down) => (event) => {
    // Keys typed into the toolbar's own controls stay local.
    if (!viewing() || (event.target instanceof Element && event.target.closest('.toolbar, #panel'))) return;
    event.preventDefault();
    const plainText = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    if (plainText) {
      if (down) control({ t: 't', ch: event.key });
      return;
    }
    control({ t: 'k', code: translateCode(event.code), down });
  };
  window.addEventListener('keydown', key(true), true);
  window.addEventListener('keyup', key(false), true);
  window.addEventListener('blur', () => {
    if (viewing()) control({ t: 'release' });
  });

  $('viewer-quality').addEventListener('change', (event) => {
    prefs.quality = event.target.value;
    savePrefs();
    $('pref-quality').value = prefs.quality;
    control({ t: 'quality', value: prefs.quality });
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
  $('request-accept').addEventListener('click', () => {
    if (!incoming) return;
    $('request').hidden = true;
    send({ type: 'answer', sessionId: incoming.sessionId, accept: true });
  });
  $('request-reject').addEventListener('click', () => {
    if (!incoming) return;
    send({ type: 'answer', sessionId: incoming.sessionId, accept: false });
    closeRequest();
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
  $('hosting-stop').addEventListener('click', () => endSession(true));
  $('viewer-stop').addEventListener('click', () => endSession(true));
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
    if (session && (session.role === 'viewer' || prefs.allowClipboard)) control({ t: 'clip', text });
  });
  setupViewerInput();
  setupSettings();
  setupUpdates();
  renderPeers();
  refreshPermissions(false);
  window.addEventListener('focus', () => refreshPermissions(false));
  connectServer();
}

main();
