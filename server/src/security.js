'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PIN_RE = /^\d{6}$/;
// Lettere/numeri (anche accentati), spazio, punto, trattino, underscore. 3-16 caratteri, niente spazi ai bordi.
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]{1,14})[\p{L}\p{N}]$/u;

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  return e;
}

function isValidPin(pin) {
  return typeof pin === 'string' && PIN_RE.test(pin);
}

// Restituisce { display, key } oppure null. "key" serve per l'unicità senza distinguere maiuscole/accenti compatibili.
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const display = raw.normalize('NFKC').trim().replace(/ {2,}/g, ' ');
  if (!NAME_RE.test(display)) return null;
  return { display, key: display.toLowerCase() };
}

// L'email non viene mai salvata: si conserva solo questo hash (HMAC con segreto del server).
function emailHash(secret, email) {
  return crypto.createHmac('sha256', secret).update('email:' + email).digest('hex');
}

// scrypt con salt casuale + "pepper" del server: un furto del solo database non basta per provare tutti i PIN.
async function hashPin(secret, pin) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pin, Buffer.concat([salt, Buffer.from(secret)]), 32);
  return `${salt.toString('base64')}:${key.toString('base64')}`;
}

async function verifyPin(secret, pin, stored) {
  const [saltB64, keyB64] = String(stored || '').split(':');
  const salt = Buffer.from(saltB64 || '', 'base64');
  const expected = Buffer.from(keyB64 || '', 'base64');
  const key = await scrypt(pin, Buffer.concat([salt, Buffer.from(secret)]), 32);
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function newId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { normalizeEmail, isValidPin, normalizeName, emailHash, hashPin, verifyPin, newToken, sha256, newId };
