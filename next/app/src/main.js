'use strict';
const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, ipcMain, nativeImage, screen, session, shell, systemPreferences } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const input = require('./input');
const accessStore = require('./access');
const fileStore = require('./files');

const PRODUCTION_SERVER_URL = 'ws://185.233.247.38:21200';
// A local server can be used while developing; packaged builds ignore it.
const SERVER_URL = (!app.isPackaged && process.env.FREEDESK_SERVER) || PRODUCTION_SERVER_URL;
const DOWNLOAD_PAGE = 'https://github.com/tuncer4427/freedesk/releases/tag/fardesk-latest';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CLIPBOARD_POLL_MS = 700;
// Kept well under the data channel's message size limit.
const MAX_CLIPBOARD_CHARS = 60 * 1000;

let mainWindow = null;
let hosting = false;
let clipboardTimer = null;
let lastClipboardText = '';
let updater = null;
let tray = null;
let requestWindow = null;
let labelWindow = null;
let labelHideTimer = null;
let lastLabelText = '';
let lastLabelMove = 0;
const LABEL_SIZE = { width: 240, height: 30 };
const LABEL_IDLE_MS = 2500;
const LABEL_MOVE_INTERVAL_MS = 25;
let quitting = false;
// Closing the window keeps the app running in the tray, so the computer stays
// reachable; the renderer turns this off when the user prefers a real exit.
let keepRunning = true;
const START_HIDDEN = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function loadDeviceKey() {
  const file = path.join(app.getPath('userData'), 'device.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceKey === 'string' && /^[0-9a-f]{64}$/.test(saved.deviceKey)) return saved.deviceKey;
  } catch {}
  const deviceKey = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ deviceKey }), { mode: 0o600 });
  return deviceKey;
}

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#f4f6f8',
    title: 'FarDesk',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: !START_HIDDEN,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    if (quitting || !keepRunning || !tray) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- connection request popup ------------------------------------------------
// A small window in the middle of the screen. It is shown without taking the
// keyboard focus, so a key being typed elsewhere can never accept a request.
function showRequest(data) {
  const deliver = () => {
    if (!requestWindow || requestWindow.isDestroyed()) return;
    requestWindow.webContents.send('request:data', data);
    requestWindow.center();
    requestWindow.showInactive();
    requestWindow.moveTop();
  };
  if (requestWindow && !requestWindow.isDestroyed()) return deliver();
  requestWindow = new BrowserWindow({
    width: 400,
    height: 216,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Bağlantı isteği',
    webPreferences: {
      preload: path.join(__dirname, 'request-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  requestWindow.setAlwaysOnTop(true, 'floating');
  requestWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  requestWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  requestWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  requestWindow.on('closed', () => {
    requestWindow = null;
  });
  requestWindow.loadFile(path.join(__dirname, 'renderer', 'request.html')).then(deliver);
}

function hideRequest() {
  if (requestWindow && !requestWindow.isDestroyed()) requestWindow.hide();
}

// --- name tag next to the pointer --------------------------------------------
// Shows who is moving the pointer on this computer. It never takes clicks or
// focus, and disappears when the pointer rests or the session ends.
function showCursorLabel(nx, ny, text) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  const now = Date.now();
  if (now - lastLabelMove < LABEL_MOVE_INTERVAL_MS) return;
  lastLabelMove = now;
  try {
    if (!labelWindow || labelWindow.isDestroyed()) {
      lastLabelText = '';
      labelWindow = new BrowserWindow({
        ...LABEL_SIZE,
        frame: false,
        transparent: true,
        resizable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        alwaysOnTop: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      labelWindow.setIgnoreMouseEvents(true);
      labelWindow.setAlwaysOnTop(true, 'screen-saver');
      labelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      const created = labelWindow;
      // Write the name once the page exists; until then the tag stays hidden.
      created
        .loadFile(path.join(__dirname, 'renderer', 'label.html'))
        .then(() => {
          if (labelWindow === created && lastLabelText) writeCursorLabel(lastLabelText);
        })
        .catch(() => {});
    }
    if (text !== lastLabelText) {
      lastLabelText = text;
      if (!labelWindow.webContents.isLoading()) writeCursorLabel(text);
    }
    const { bounds } = screen.getPrimaryDisplay();
    const x = Math.min(bounds.x + bounds.width - LABEL_SIZE.width, Math.round(bounds.x + nx * bounds.width + 14));
    const y = Math.min(bounds.y + bounds.height - LABEL_SIZE.height, Math.round(bounds.y + ny * bounds.height + 20));
    labelWindow.setBounds({ x, y, ...LABEL_SIZE });
    if (!labelWindow.isVisible()) labelWindow.showInactive();
    clearTimeout(labelHideTimer);
    labelHideTimer = setTimeout(() => {
      if (labelWindow && !labelWindow.isDestroyed()) labelWindow.hide();
    }, LABEL_IDLE_MS);
  } catch (err) {
    console.error('cursor label:', err.message);
  }
}

function writeCursorLabel(text) {
  labelWindow.webContents.executeJavaScript(`setLabel(${JSON.stringify(text)})`).catch(() => {});
}

function closeCursorLabel() {
  clearTimeout(labelHideTimer);
  if (labelWindow && !labelWindow.isDestroyed()) labelWindow.destroy();
  labelWindow = null;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitApp() {
  quitting = true;
  closeCursorLabel();
  if (requestWindow && !requestWindow.isDestroyed()) requestWindow.destroy();
  app.quit();
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')).resize({ width: 18, height: 18 });
    tray = new Tray(image);
    tray.setToolTip('FarDesk');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'FarDesk’i aç', click: showWindow },
        { type: 'separator' },
        { label: 'Çıkış', click: quitApp },
      ]),
    );
    tray.on('click', showWindow);
  } catch (err) {
    // Without a tray there is no way back to a hidden window, so closing quits.
    tray = null;
    console.error('tray unavailable:', err.message);
  }
}

// --- clipboard sharing while a session is open ------------------------------
function startClipboard() {
  stopClipboard();
  lastClipboardText = clipboard.readText();
  clipboardTimer = setInterval(() => {
    const text = clipboard.readText();
    if (text === lastClipboardText) return;
    lastClipboardText = text;
    if (text && text.length <= MAX_CLIPBOARD_CHARS) sendToWindow('clipboard:changed', text);
  }, CLIPBOARD_POLL_MS);
}

function stopClipboard() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = null;
}

// --- updates -----------------------------------------------------------------
function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('updater unavailable:', err.message);
    return;
  }
  // Unsigned macOS apps cannot replace themselves, so there the user is
  // pointed at the download page instead.
  const canSelfUpdate = process.platform === 'win32';
  autoUpdater.autoDownload = canSelfUpdate;
  autoUpdater.autoInstallOnAppQuit = canSelfUpdate;
  autoUpdater.on('update-available', (info) => {
    if (!canSelfUpdate) sendToWindow('update:status', { state: 'manual', version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendToWindow('update:status', { state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => console.error('update error:', err.message));
  ipcMain.on('update:install', () => {
    if (canSelfUpdate) {
      quitting = true;
      autoUpdater.quitAndInstall(true, true);
    }
    else shell.openExternal(DOWNLOAD_PAGE);
  });
  updater = autoUpdater;
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('update check failed:', err.message));
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// --- IPC ---------------------------------------------------------------------
function setupIpc(deviceKey) {
  const access = accessStore.create(path.join(app.getPath('userData'), 'access.json'));
  const files = fileStore.create(() => path.join(app.getPath('downloads'), 'FarDesk'));
  const received = new Set(); // paths this app saved, the only ones it will reveal

  ipcMain.handle('access:status', () => ({ enabled: access.enabled(), minLength: accessStore.MIN_PASSWORD_LENGTH }));
  ipcMain.handle('access:set', (_event, password) => access.set(password));
  ipcMain.handle('access:clear', () => access.clear());
  ipcMain.handle('access:challenge', (_event, sessionId) => access.challenge(sessionId));
  ipcMain.handle('access:verify', (_event, sessionId, proof) => access.verify(sessionId, proof));
  ipcMain.on('access:forget', (_event, sessionId) => access.forget(sessionId));
  ipcMain.handle('access:derive', (_event, password, salt) => access.deriveKey(password, salt));
  ipcMain.handle('access:answer', (_event, key, nonce, sessionId) => access.answer(key, nonce, sessionId));

  ipcMain.handle('file:begin', (_event, id, name, size) => files.begin(id, name, size));
  ipcMain.on('file:chunk', (_event, id, data) => files.chunk(id, data));
  ipcMain.handle('file:end', async (_event, id) => {
    const saved = await files.end(id);
    if (saved) received.add(saved);
    return saved;
  });
  ipcMain.on('file:abort', () => files.abortAll());
  ipcMain.on('file:reveal', (_event, file) => {
    if (received.has(file)) shell.showItemInFolder(file);
  });

  ipcMain.handle('mic:access', async () => {
    if (process.platform !== 'darwin') return true;
    return systemPreferences.askForMediaAccess('microphone');
  });

  ipcMain.on('app:background', (_event, enabled) => {
    keepRunning = enabled === true;
  });

  ipcMain.handle('app:autostart', (_event, enabled) => {
    if (!app.isPackaged) return false;
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  });

  ipcMain.on('app:attention', () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.flashFrame(true);
    setTimeout(() => mainWindow && !mainWindow.isDestroyed() && mainWindow.flashFrame(false), 4000);
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    deviceKey,
    serverUrl: SERVER_URL,
    name: os.hostname(),
    inputAvailable: input.available(),
    inputError: input.loadError(),
  }));

  ipcMain.handle('update:check', async () => {
    if (!updater) return { state: 'unavailable' };
    try {
      const result = await updater.checkForUpdates();
      const version = result && result.updateInfo ? result.updateInfo.version : null;
      const available =
        result && typeof result.isUpdateAvailable === 'boolean'
          ? result.isUpdateAvailable
          : Boolean(version) && version !== app.getVersion();
      return available ? { state: 'available', version } : { state: 'current' };
    } catch {
      return { state: 'error' };
    }
  });

  ipcMain.handle('host:permissions', (_event, prompt) => {
    if (process.platform !== 'darwin') return { screen: true, control: true };
    return {
      screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      control: systemPreferences.isTrustedAccessibilityClient(prompt === true),
    };
  });

  ipcMain.handle('host:open-settings', (_event, which) => {
    if (process.platform !== 'darwin') return;
    const pane = which === 'control' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
    return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  });

  // The page asks for the screen with getDisplayMedia; the primary display is
  // handed over without a picker because the user already approved the session.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const primary = screen.getPrimaryDisplay();
        const source = sources.find((s) => s.display_id === String(primary.id)) || sources[0];
        if (source) callback({ video: source });
        else callback({});
      })
      .catch(() => callback({}));
  });

  ipcMain.on('host:session', (_event, active) => {
    hosting = active === true;
    if (!hosting) {
      input.releaseAll();
      closeCursorLabel();
    }
  });

  ipcMain.on('host:input', (_event, msg, label) => {
    if (!hosting) return;
    input.handle(msg);
    if (msg && (msg.t === 'm' || msg.t === 'd') && typeof label === 'string' && label) {
      showCursorLabel(msg.x, msg.y, label.slice(0, 48));
    }
  });

  // Only the main window may open the popup, and only the popup may answer.
  const fromMain = (event) => mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
  ipcMain.on('request:show', (event, data) => {
    if (fromMain(event) && data && typeof data === 'object') showRequest(data);
  });
  ipcMain.on('request:hide', (event) => {
    if (fromMain(event)) hideRequest();
  });
  ipcMain.on('request:answer', (event, answer) => {
    if (!requestWindow || requestWindow.isDestroyed() || event.sender !== requestWindow.webContents) return;
    hideRequest();
    sendToWindow('request:answer', answer);
  });

  ipcMain.on('clipboard:sync', (_event, active) => {
    if (active === true) startClipboard();
    else stopClipboard();
  });

  ipcMain.on('clipboard:write', (_event, text) => {
    if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_CHARS) return;
    lastClipboardText = text;
    clipboard.writeText(text);
  });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  setupIpc(loadDeviceKey());
  createTray();
  createWindow();
  setupUpdates();
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  input.releaseAll();
  stopClipboard();
  app.quit();
});
