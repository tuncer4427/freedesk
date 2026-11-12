'use strict';
// Writes files received from the other computer into Downloads/FarDesk.
// Names come from the network, so they are reduced to a safe base name and an
// existing file is never overwritten.
const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_OPEN_FILES = 4;

function safeName(name) {
  const base = String(name).split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 180);
  if (!cleaned || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned)) return `dosya-${Date.now()}`;
  return cleaned;
}

function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function create(getDir) {
  const open = new Map(); // id -> { stream, path, size, written, failed }

  const fail = (id) => {
    const file = open.get(id);
    if (!file) return;
    open.delete(id);
    file.stream.destroy();
    fs.unlink(file.path, () => {});
  };

  return {
    begin(id, name, size) {
      if (typeof id !== 'string' || id.length > 64 || open.has(id) || open.size >= MAX_OPEN_FILES) return null;
      if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return null;
      const dir = getDir();
      fs.mkdirSync(dir, { recursive: true });
      const target = freePath(dir, safeName(name));
      const stream = fs.createWriteStream(target, { flags: 'wx' });
      const file = { stream, path: target, size, written: 0, failed: false };
      stream.on('error', () => {
        file.failed = true;
        fail(id);
      });
      open.set(id, file);
      return path.basename(target);
    },

    chunk(id, data) {
      const file = open.get(id);
      if (!file || !(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
      const buffer = Buffer.from(data instanceof ArrayBuffer ? data : data.buffer, data.byteOffset || 0, data.byteLength);
      file.written += buffer.length;
      if (file.written > file.size) return fail(id);
      file.stream.write(buffer);
    },

    end(id) {
      const file = open.get(id);
      if (!file) return Promise.resolve(null);
      if (file.written !== file.size) {
        fail(id);
        return Promise.resolve(null);
      }
      open.delete(id);
      return new Promise((resolve) => file.stream.end(() => resolve(file.failed ? null : file.path)));
    },

    abortAll() {
      for (const id of [...open.keys()]) fail(id);
    },
  };
}

module.exports = { create, safeName };
