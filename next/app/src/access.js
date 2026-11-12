'use strict';
// Unattended access password. The password itself is never stored or sent:
// a key derived from it is kept on this device, and a connecting device proves
// it knows the same key by answering a one-time challenge.
const crypto = require('crypto');
const fs = require('fs');

const ITERATIONS = 200000;
const KEY_BYTES = 32;
const MIN_PASSWORD_LENGTH = 8;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;
const MAX_TRIES_PER_SESSION = 3;

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);

function derive(password, saltHex) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, Buffer.from(saltHex, 'hex'), ITERATIONS, KEY_BYTES, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

function proofFor(keyHex, nonceHex, sessionId) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`${nonceHex}:${sessionId}`).digest('hex');
}

function create(file) {
  let saved = null; // { salt, key }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (HEX(32).test(data.salt) && HEX(64).test(data.key)) saved = { salt: data.salt, key: data.key };
  } catch {}

  const challenges = new Map(); // sessionId -> { nonce, tries }
  let failures = [];

  const locked = () => {
    const now = Date.now();
    failures = failures.filter((t) => now - t < LOCK_MS);
    return failures.length >= MAX_FAILURES;
  };

  return {
    enabled: () => saved !== null,

    async set(password) {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 128) return false;
      const salt = crypto.randomBytes(16).toString('hex');
      saved = { salt, key: await derive(password, salt) };
      fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      return true;
    },

    clear() {
      saved = null;
      challenges.clear();
      try {
        fs.unlinkSync(file);
      } catch {}
    },

    // Host: start a password check for one incoming request.
    challenge(sessionId) {
      if (!saved || locked() || typeof sessionId !== 'string') return null;
      const nonce = crypto.randomBytes(16).toString('hex');
      challenges.set(sessionId, { nonce, tries: 0 });
      return { salt: saved.salt, nonce };
    },

    // Host: check the connecting device's answer.
    verify(sessionId, proof) {
      const challenge = challenges.get(sessionId);
      if (!saved || !challenge || locked() || typeof proof !== 'string' || !HEX(64).test(proof)) return false;
      challenge.tries += 1;
      if (challenge.tries > MAX_TRIES_PER_SESSION) {
        challenges.delete(sessionId);
        return false;
      }
      const expected = Buffer.from(proofFor(saved.key, challenge.nonce, sessionId), 'hex');
      const ok = crypto.timingSafeEqual(expected, Buffer.from(proof, 'hex'));
      if (ok) challenges.delete(sessionId);
      else failures.push(Date.now());
      return ok;
    },

    forget(sessionId) {
      challenges.delete(sessionId);
    },

    // Connecting device: turn a typed password into the key, and a key into an answer.
    async deriveKey(password, salt) {
      if (typeof password !== 'string' || password.length > 128 || !HEX(32).test(salt)) return null;
      return derive(password, salt);
    },

    answer(key, nonce, sessionId) {
      if (!HEX(64).test(key) || !HEX(32).test(nonce) || typeof sessionId !== 'string') return null;
      return proofFor(key, nonce, sessionId);
    },
  };
}

module.exports = { create, MIN_PASSWORD_LENGTH };
