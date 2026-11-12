'use strict';
const { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, screen, shell, systemPreferences } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const input = require('./input');

const PRODUCTION_SERVER_URL = 'ws://185.233.247.38:21200';
// A local server can be used while developing; packaged builds ignore it.
const SERVER_URL = (!app.isPackaged && process.env.FREEDESK_SERVER) || PRODUCTION_SERVER_URL;
const DOWNLOAD_PAGE = 'https://github.com/tuncer4427/freedesk/releases/tag/app-latest';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CLIPBOARD_POLL_MS = 700;
// Kept well under the data channel's message size limit.
const MAX_CLIPBOARD_CHARS = 60 * 1000;

let mainWindow = null;
let hosting = false;
let clipboardTimer = null;
let lastClipboardText = '';

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
    backgroundColor: '#0f1720',
    title: 'FreeDesk Beta',
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
    if (canSelfUpdate) autoUpdater.quitAndInstall(true, true);
    else shell.openExternal(DOWNLOAD_PAGE);
  });
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('update check failed:', err.message));
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

// --- IPC ---------------------------------------------------------------------
function setupIpc(deviceKey) {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    deviceKey,
    serverUrl: SERVER_URL,
    name: os.hostname(),
    inputAvailable: input.available(),
    inputError: input.loadError(),
  }));

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

  ipcMain.handle('host:source', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (sources.length === 0) throw new Error('no screen available');
    const primary = screen.getPrimaryDisplay();
    const source = sources.find((s) => s.display_id === String(primary.id)) || sources[0];
    return { sourceId: source.id };
  });

  ipcMain.on('host:session', (_event, active) => {
    hosting = active === true;
    if (!hosting) input.releaseAll();
  });

  ipcMain.on('host:input', (_event, msg) => {
    if (hosting) input.handle(msg);
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

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(() => {
  setupIpc(loadDeviceKey());
  createWindow();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  input.releaseAll();
  stopClipboard();
  app.quit();
});
