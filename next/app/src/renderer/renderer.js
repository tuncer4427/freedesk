'use strict';
// UI, signaling and WebRTC for both roles: "host" (this screen is shared and
// controlled) and "viewer" (this window shows and controls a remote screen).

const $ = (id) => document.getElementById(id);
const api = window.freedesk;

const RECONNECT_MS = 3000;
const MAX_BITRATE = 12 * 1000 * 1000;
const MAX_FRAMERATE = 60;
const MOVE_INTERVAL_MS = 8;
const RECENT_KEY = 'freedesk.recent';
const MAX_RECENT = 6;

let info = null;
let socket = null;
let myId = null;
let pending = null; // viewer waiting for an answer: { sessionId, to }
let incoming = null; // host deciding on a request: { sessionId, from }
let session = null; // { role, sessionId, peerId, pc, channel, stream, hostPlatform }
let starting = null; // host preparing its screen: { sessionId, signals }
let signalChain = Promise.resolve();

const formatId = (id) => id.replace(/(\d{3})(?=\d)/g, '$1 ');
const digits = (text) => text.replace(/\D/g, '').slice(0, 9);

function setStatus(state, text) {
  $('status').dataset.state = state;
  $('status').textContent = text;
  $('connect-button').disabled = state !== 'online' || digits($('remote-id').value).length !== 9;
}

function setMessage(text) {
  $('connect-message').textContent = text || '';
}

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
        if (session.role === 'host') tuneSender(pc);
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (err) {
    console.error('signal error', err);
  }
}

function tuneSender(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_BITRATE;
    params.encodings[0].maxFramerate = MAX_FRAMERATE;
    params.degradationPreference = 'balanced';
    sender.setParameters(params).catch((err) => console.error('sender params', err));
  }
}

function bindChannel(channel) {
  session.channel = channel;
  channel.onopen = () => {
    api.syncClipboard(true);
    if (session && session.role === 'host') channel.send(JSON.stringify({ t: 'hello', platform: info.platform }));
  };
  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!session || !msg) return;
    if (msg.t === 'clip') return api.writeClipboard(msg.text);
    if (session.role === 'host') api.input(msg);
    else if (msg.t === 'hello') session.hostPlatform = msg.platform;
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
      video: { frameRate: MAX_FRAMERATE },
    });
    if (!starting || starting.sessionId !== sessionId) {
      // The request was cancelled while the capture was starting.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const pc = createPeer(msg.iceServers);
    session = { role: 'host', sessionId, peerId: from, pc, channel: null, stream };
    for (const track of stream.getTracks()) {
      track.contentHint = 'detail';
      pc.addTrack(track, stream);
    }
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

// --- recently used addresses -------------------------------------------------
function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => /^\d{9}$/.test(id)).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(id) {
  const list = [id, ...loadRecent().filter((other) => other !== id)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  const box = $('recent');
  box.replaceChildren();
  $('recent-section').hidden = list.length === 0;
  for (const id of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-item';
    item.textContent = formatId(id);
    item.addEventListener('click', () => {
      $('remote-id').value = formatId(id);
      $('remote-id').dispatchEvent(new Event('input', { bubbles: true }));
      $('connect-form').requestSubmit();
    });
    box.append(item);
  }
}

// --- viewer role -------------------------------------------------------------
async function startViewer(msg) {
  const { sessionId, to } = pending;
  pending = null;
  setMessage('');
  const pc = createPeer(msg.iceServers);
  session = { role: 'viewer', sessionId, peerId: to, pc, channel: null, stream: null, hostPlatform: null };
  rememberRecent(to);
  bindChannel(pc.createDataChannel('control', { ordered: true }));
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (event) => {
    // Show each frame as soon as it arrives rather than buffering for smoothness.
    if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
    $('screen').srcObject = event.streams[0] || new MediaStream([event.track]);
  };
  $('viewer-title').textContent = formatId(to);
  $('viewer-state').textContent = 'Bağlanıyor…';
  $('home').hidden = true;
  $('viewer').hidden = false;
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

function endSession(notify) {
  if (!session) return;
  const ended = session;
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
    $('viewer').hidden = true;
    $('home').hidden = false;
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
    $('stage').focus();
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
    if (!viewing()) return;
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
  $('version').textContent = `Sürüm ${info.version}`;

  $('remote-id').addEventListener('input', (event) => {
    event.target.value = formatId(digits(event.target.value));
    setMessage('');
    $('connect-button').disabled = !myId || digits(event.target.value).length !== 9;
  });
  $('connect-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const to = digits($('remote-id').value);
    if (to.length !== 9 || pending || session || !myId) return;
    setMessage('Bağlanıyor…');
    send({ type: 'connect', to, name: info.name });
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
  });

  api.onClipboard((text) => control({ t: 'clip', text }));
  setupViewerInput();
  setupUpdates();
  renderRecent();
  refreshPermissions(false);
  window.addEventListener('focus', () => refreshPermissions(false));
  connectServer();
}

main();
