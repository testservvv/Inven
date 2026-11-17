// Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s) as used
// by all common authenticator apps, plus single-use recovery codes.
import crypto from 'node:crypto';
import { randomString, safeEqual, sha256 } from './security.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Ungültiges Base32-Zeichen');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(key, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret, time = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(time / 1000 / STEP_SECONDS));
}

/**
 * Checks a code against the current time step ±1 (clock drift).
 * Returns the matching step, or null. Steps up to `afterStep` are rejected so
 * that a code observed once cannot be replayed.
 */
export function verifyTotp(secret, code, { time = Date.now(), afterStep = 0 } = {}) {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secret);
  const current = Math.floor(time / 1000 / STEP_SECONDS);
  let matched = null;
  for (const step of [current - 1, current, current + 1]) {
    if (step > afterStep && safeEqual(hotp(key, step), digits)) matched = step;
  }
  return matched;
}

/** The otpauth:// URI that authenticator apps read from the enrolment QR code. */
export function otpauthUrl({ issuer, account, secret }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

/** Secret in groups of four for manual entry. */
export const formatSecret = (secret) => secret.replace(/(.{4})/g, '$1 ').trim();

// --- Recovery codes ---------------------------------------------------------
// 10 random characters from a 31-symbol alphabet (≈49.5 bits). Because they are
// random and high-entropy, a plain SHA-256 is sufficient for storing them.
export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => `${randomString(5)}-${randomString(5)}`);
}

export const normalizeRecoveryCode = (input) => String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const hashRecoveryCode = (code) => sha256(`recovery:${normalizeRecoveryCode(code)}`);
