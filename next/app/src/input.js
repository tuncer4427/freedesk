'use strict';
// Turns control messages from the viewer into local mouse and keyboard input.
// Every value comes from the network, so each one is validated before use.

let robot = null;
let loadError = null;
try {
  robot = require('@jitsi/robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
} catch (err) {
  loadError = err;
}

const KEY_BY_CODE = {
  Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab',
  Space: 'space', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown', ArrowUp: 'up', ArrowDown: 'down',
  ArrowLeft: 'left', ArrowRight: 'right', CapsLock: 'capslock', PrintScreen: 'printscreen',
  ContextMenu: 'menu',
  ShiftLeft: 'shift', ShiftRight: 'right_shift', ControlLeft: 'control', ControlRight: 'right_control',
  AltLeft: 'alt', AltRight: 'right_alt', MetaLeft: 'command', MetaRight: 'command',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
for (const letter of 'abcdefghijklmnopqrstuvwxyz') KEY_BY_CODE[`Key${letter.toUpperCase()}`] = letter;
for (let n = 0; n <= 9; n += 1) {
  KEY_BY_CODE[`Digit${n}`] = String(n);
  KEY_BY_CODE[`Numpad${n}`] = `numpad_${n}`;
}
for (let n = 1; n <= 24; n += 1) KEY_BY_CODE[`F${n}`] = `f${n}`;

const BUTTONS = ['left', 'middle', 'right'];
const keysDown = new Set();
const buttonsDown = new Set();

const unit = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null);

function moveTo(x, y) {
  const nx = unit(x);
  const ny = unit(y);
  if (nx === null || ny === null) return;
  const size = robot.getScreenSize();
  const px = Math.round(nx * (size.width - 1));
  const py = Math.round(ny * (size.height - 1));
  // macOS only delivers drags when the move is posted as a drag event.
  if (buttonsDown.size > 0 && process.platform === 'darwin') robot.dragMouse(px, py);
  else robot.moveMouse(px, py);
}

function handle(msg) {
  if (!robot || !msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'm':
      moveTo(msg.x, msg.y);
      break;
    case 'd':
    case 'u': {
      const button = BUTTONS[msg.b];
      if (!button) return;
      moveTo(msg.x, msg.y);
      if (msg.t === 'd') buttonsDown.add(button);
      else buttonsDown.delete(button);
      robot.mouseToggle(msg.t === 'd' ? 'down' : 'up', button);
      break;
    }
    case 'w': {
      if (!Number.isFinite(msg.dx) || !Number.isFinite(msg.dy)) return;
      const clamp = (v) => Math.round(Math.min(2000, Math.max(-2000, v)));
      const dx = process.platform === 'darwin' ? -clamp(msg.dx) : clamp(msg.dx);
      robot.scrollMouse(dx, -clamp(msg.dy));
      break;
    }
    case 'k': {
      const key = Object.hasOwn(KEY_BY_CODE, msg.code) ? KEY_BY_CODE[msg.code] : null;
      if (!key) return;
      if (msg.down === true) keysDown.add(key);
      else keysDown.delete(key);
      robot.keyToggle(key, msg.down === true ? 'down' : 'up');
      break;
    }
    case 't': {
      // A typed character, sent as text so it does not depend on either
      // side's keyboard layout.
      if (typeof msg.ch !== 'string') return;
      const code = msg.ch.codePointAt(0);
      if (code === undefined || code < 0x20 || code > 0xffff || msg.ch.length !== 1) return;
      robot.unicodeTap(code);
      break;
    }
    case 'release':
      releaseAll();
      break;
    default:
  }
}

function releaseAll() {
  if (!robot) return;
  for (const key of keysDown) {
    try {
      robot.keyToggle(key, 'up');
    } catch {}
  }
  for (const button of buttonsDown) {
    try {
      robot.mouseToggle('up', button);
    } catch {}
  }
  keysDown.clear();
  buttonsDown.clear();
}

function safeHandle(msg) {
  try {
    handle(msg);
  } catch (err) {
    console.error('input error:', err.message);
  }
}

module.exports = {
  handle: safeHandle,
  releaseAll,
  available: () => robot !== null,
  loadError: () => (loadError ? loadError.message : null),
};
