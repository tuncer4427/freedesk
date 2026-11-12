'use strict';
// UI, signaling and WebRTC for both roles: "host" (this screen is shared and
// controlled) and "viewer" (this window shows and controls a remote screen).

const $ = (id) => document.getElementById(id);
const api = window.freedesk;

const RECONNECT_MS = 3000;
const MOVE_INTERVAL_MS = 8;
const PEERS_KEY = 'freedesk.peers';
const PREFS_KEY = 'freedesk.prefs';
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
    peer = { id, name: '', fav: false, last: 0, thumb: '' };
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
}

function closeRequest() {
  incoming = null;
  $('request').hidden = true;
}

// --- WebRTC ------------------------------------------------------------------
function createPeer(iceServers) {
  const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  pc.onicecandidate = (event) => {
    if (event.candidate && session) send({ type: 'signal', sessionId: session.sessionId, data: { candidate: event.candidate } });
  };
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
      } else if (prefs.allowControl) {
        api.input(msg);
      }
    } else if (msg.t === 'clip') {
      api.writeClipboard(msg.text);
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
    pc.ondatachannel = (event) => bindChannel(event.channel);
    api.setHosting(true);
    $('hosting-peer').textContent = formatId(from);
    $('hosting').hidden = false;
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
  const { sessionId, to } = pending;
  pending = null;
  setMessage('');
  const pc = createPeer(msg.iceServers);
  session = { role: 'viewer', sessionId, peerId: to, pc, channel: null, stream: null, hostPlatform: null };
  updatePeer(to, { last: Date.now() });
  bindChannel(pc.createDataChannel('control', { ordered: true }));
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    // Show each frame as soon as it arrives rather than buffering for smoothness.
    if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
    $('screen').srcObject = event.streams[0] || new MediaStream([event.track]);
  };
  const known = loadPeers().find((p) => p.id === to);
  $('viewer-title').textContent = known && known.name ? `${known.name} · ${formatId(to)}` : formatId(to);
  $('viewer-state').textContent = 'Bağlanıyor…';
  $('viewer-quality').value = prefs.quality;
  applyScale(prefs.scale);
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
    if (!viewing() || (event.target instanceof Element && event.target.closest('.toolbar'))) return;
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
  darkQuery.addEventListener('change', applyTheme);

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
