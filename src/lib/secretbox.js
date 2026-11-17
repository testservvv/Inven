// Encrypts small secrets (the TOTP seeds) at rest with AES-256-GCM.
// The key lives in DATA_DIR/app.key, outside the database file, so a leaked
// database copy alone does not expose the second factor of any account.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';

let key;

function appKey() {
  if (key) return key;
  try {
    key = Buffer.from(fs.readFileSync(paths.appKey, 'utf8').trim(), 'base64');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(paths.appKey), { recursive: true });
    fs.writeFileSync(paths.appKey, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (key.length !== 32) throw new Error(`${paths.appKey} ist beschädigt (erwartet: 32 Byte, Base64-kodiert)`);
  return key;
}

/** Re-read the key file on next use (after a backup with another key was restored). */
export function forgetKey() {
  key = undefined;
}

export function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', appKey(), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** Returns the plaintext, or null when the value was not sealed with the current key. */
export function open(sealed) {
  const [version, iv, tag, data] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', appKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
