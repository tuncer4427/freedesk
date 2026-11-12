'use strict';
// End-to-end check of the signaling flow against a real server instance.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

process.env.PORT = '0';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'freedesk-test-'));
process.env.PUBLIC_HOST = 'example.test';
process.env.TURN_SECRET = 'secret';
const { httpServer, wss } = require('./server');

function client(url) {
  const socket = new WebSocket(url);
  const queue = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    socket,
    open: () => new Promise((resolve) => socket.once('open', resolve)),
    send: (msg) => socket.send(JSON.stringify(msg)),
    next: () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 2000);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      }),
    quiet: () => new Promise((resolve) => setTimeout(() => resolve(queue.length === 0), 200)),
  };
}

async function main() {
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}`;
  const keyA = crypto.randomBytes(32).toString('hex');
  const keyB = crypto.randomBytes(32).toString('hex');

  const a = client(url);
  const b = client(url);
  await Promise.all([a.open(), b.open()]);

  a.send({ type: 'connect', to: '123456789' });
  assert.strictEqual((await a.next()).code, 'not-registered');

  a.send({ type: 'hello', deviceKey: keyA });
  b.send({ type: 'hello', deviceKey: keyB });
  const wa = await a.next();
  const wb = await b.next();
  assert.match(wa.id, /^\d{9}$/);
  assert.notStrictEqual(wa.id, wb.id);
  assert.strictEqual(wa.iceServers.length, 2);
  assert.ok(wa.iceServers[1].credential);

  a.send({ type: 'connect', to: '000000000' });
  assert.strictEqual((await a.next()).code, 'unavailable');
  a.send({ type: 'connect', to: wa.id });
  assert.strictEqual((await a.next()).code, 'self');

  // Rejected request.
  a.send({ type: 'connect', to: wb.id, name: 'A' });
  const ringing = await a.next();
  const incoming = await b.next();
  assert.strictEqual(incoming.from, wa.id);
  assert.strictEqual(incoming.name, 'A');
  // Signals before acceptance must not be relayed.
  a.send({ type: 'signal', sessionId: ringing.sessionId, data: { early: true } });
  assert.ok(await b.quiet());
  b.send({ type: 'answer', sessionId: incoming.sessionId, accept: false });
  assert.strictEqual((await a.next()).reason, 'rejected');
  assert.strictEqual((await b.next()).reason, 'rejected');

  // Accepted request, relayed signals, hang-up.
  a.send({ type: 'connect', to: wb.id });
  const ringing2 = await a.next();
  const incoming2 = await b.next();
  // Password messages are relayed both ways before acceptance, within limits.
  b.send({ type: 'auth', sessionId: incoming2.sessionId, data: { kind: 'challenge', nonce: 'n' } });
  assert.deepStrictEqual((await a.next()).data, { kind: 'challenge', nonce: 'n' });
  a.send({ type: 'auth', sessionId: ringing2.sessionId, data: { kind: 'proof', proof: 'p' } });
  assert.strictEqual((await b.next()).data.kind, 'proof');
  a.send({ type: 'auth', sessionId: ringing2.sessionId, data: { big: 'x'.repeat(2000) } });
  a.send({ type: 'auth', sessionId: ringing2.sessionId, data: 'text' });
  assert.ok(await b.quiet());
  // Only the host may answer.
  a.send({ type: 'answer', sessionId: ringing2.sessionId, accept: true });
  assert.ok(await a.quiet());
  b.send({ type: 'answer', sessionId: incoming2.sessionId, accept: true });
  assert.strictEqual((await a.next()).type, 'accepted');
  assert.strictEqual((await b.next()).type, 'start');
  a.send({ type: 'signal', sessionId: ringing2.sessionId, data: { sdp: 'x' } });
  assert.deepStrictEqual((await b.next()).data, { sdp: 'x' });
  // No password messages once the session is accepted.
  a.send({ type: 'auth', sessionId: ringing2.sessionId, data: { kind: 'proof' } });
  assert.ok(await b.quiet());
  b.send({ type: 'signal', sessionId: ringing2.sessionId, data: { sdp: 'y' } });
  assert.deepStrictEqual((await a.next()).data, { sdp: 'y' });

  // A third device cannot inject into someone else's session.
  const c = client(url);
  await c.open();
  c.send({ type: 'hello', deviceKey: crypto.randomBytes(32).toString('hex') });
  await c.next();
  c.send({ type: 'signal', sessionId: ringing2.sessionId, data: { evil: true } });
  c.send({ type: 'auth', sessionId: ringing2.sessionId, data: { evil: true } });
  c.send({ type: 'bye', sessionId: ringing2.sessionId });
  assert.ok(await a.quiet());
  assert.ok(await b.quiet());

  a.send({ type: 'bye', sessionId: ringing2.sessionId });
  assert.strictEqual((await b.next()).reason, 'closed');

  // The ID is stable across reconnects.
  a.socket.close();
  const a2 = client(url);
  await a2.open();
  a2.send({ type: 'hello', deviceKey: keyA });
  assert.strictEqual((await a2.next()).id, wa.id);

  // Host disconnect ends a pending request.
  a2.send({ type: 'connect', to: wb.id });
  await a2.next();
  await b.next();
  b.socket.close();
  assert.strictEqual((await a2.next()).reason, 'disconnected');

  console.log('all server checks passed');
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  httpServer.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
