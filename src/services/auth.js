// Sessions, login throttling and two-factor authentication.
import { all, get, now, run } from '../db.js';
import { config } from '../config.js';
import { burnPasswordCheck, hashPassword, needsRehash, randomToken, sha256, verifyPassword } from '../lib/security.js';
import { open, seal } from '../lib/secretbox.js';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, normalizeRecoveryCode, verifyTotp } from '../lib/totp.js';
import { deleteSetting, getSetting, setSetting } from './settings.js';
import { countUsers, findUserByUsername, getUser } from './users.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Idle timeout of a normal session; the cookie itself ends with the browser session. */
const IDLE_MS = 12 * HOUR;
/** Sliding lifetime when "Angemeldet bleiben" was ticked. */
export const PERSISTENT_MS = 30 * DAY;
/** No session lives longer than this, however active it is. */
const ABSOLUTE_MS = 90 * DAY;
const CHALLENGE_MS = 5 * MINUTE;
const CHALLENGE_ATTEMPTS = 5;

const iso = (ms) => new Date(ms).toISOString();

// --- Sessions ---------------------------------------------------------------
// The cookie carries a random token; the database only stores its SHA-256, so
// a copy of the database cannot be used to take over sessions.

export function createSession(userId, { persistent = false, ip = '', userAgent = '' } = {}) {
  const token = randomToken(32);
  const created = Date.now();
  run(
    `INSERT INTO sessions (id, user_id, csrf_token, persistent, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    randomToken(32),
    persistent ? 1 : 0,
    ip,
    String(userAgent).slice(0, 300),
    iso(created),
    iso(created),
    iso(created + (persistent ? PERSISTENT_MS : IDLE_MS)),
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', iso(created), userId);
  return token;
}

/** Returns { session, user } for a valid cookie token, otherwise null. */
export function loadSession(token) {
  if (!token || token.length > 128) return null;
  const session = get('SELECT * FROM sessions WHERE id = ?', sha256(token));
  if (!session) return null;
  const nowMs = Date.now();
  const user = getUser(session.user_id);
  if (Date.parse(session.expires_at) <= nowMs || !user || !user.active) {
    run('DELETE FROM sessions WHERE id = ?', session.id);
    return null;
  }
  // Sliding expiry, written at most once a minute to keep page loads read-only.
  if (nowMs - Date.parse(session.last_seen_at) > MINUTE) {
    const cap = Date.parse(session.created_at) + ABSOLUTE_MS;
    const expires = Math.min(cap, nowMs + (session.persistent ? PERSISTENT_MS : IDLE_MS));
    run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', iso(nowMs), iso(expires), session.id);
    session.refreshed = true;
  }
  return { session, user };
}

export const destroySession = (id) => run('DELETE FROM sessions WHERE id = ?', id);
export const destroyAllSessions = (userId) => run('DELETE FROM sessions WHERE user_id = ?', userId);
export const destroyOtherSessions = (userId, keepId) => run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keepId);

export function listSessions(userId) {
  return all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, now());
}

/** One-time message shown on the next page ("Gerät gespeichert"). */
export function setFlash(sessionId, text, type = 'success') {
  run('UPDATE sessions SET flash = ? WHERE id = ?', JSON.stringify({ text, type }), sessionId);
}

export function takeFlash(session) {
  if (!session?.flash) return null;
  run('UPDATE sessions SET flash = NULL WHERE id = ?', session.id);
  try {
    return JSON.parse(session.flash);
  } catch {
    return null;
  }
}

// --- Login throttling -------------------------------------------------------
// Three counters per failed attempt:
//   pair  user+IP  – slows down guessing from one place without locking the
//                    real owner out when somebody else mistypes their name
//   user           – stops guessing that is spread over many addresses
//   ip             – stops one address from trying many usernames
// `free` failures are allowed inside `window`, then the key is locked.
const THROTTLE = {
  pair: { free: 5, window: HOUR, lockSeconds: (failures) => Math.min(900, 30 * 2 ** (failures - 5)) },
  user: { free: 25, window: HOUR, lockSeconds: () => 900 },
  ip: { free: 40, window: 15 * MINUTE, lockSeconds: () => 900 },
};

function throttleKeys(username, ip) {
  const name = String(username).trim().toLowerCase().slice(0, 64);
  return [`pair:${name}|${ip}`, `user:${name}`, `ip:${ip}`];
}

function lockedSeconds(keys) {
  let seconds = 0;
  for (const key of keys) {
    const row = get('SELECT locked_until FROM login_throttle WHERE key = ?', key);
    if (row?.locked_until) seconds = Math.max(seconds, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000));
  }
  return Math.max(0, seconds);
}

function registerFailure(keys) {
  const nowMs = Date.now();
  for (const key of keys) {
    const policy = THROTTLE[key.slice(0, key.indexOf(':'))];
    const row = get('SELECT failures, last_failure_at FROM login_throttle WHERE key = ?', key);
    const failures = row && nowMs - Date.parse(row.last_failure_at) < policy.window ? row.failures + 1 : 1;
    const lockedUntil = failures >= policy.free ? iso(nowMs + policy.lockSeconds(failures) * 1000) : null;
    run(
      `INSERT INTO login_throttle (key, failures, last_failure_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
         last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until`,
      key,
      failures,
      iso(nowMs),
      lockedUntil,
    );
  }
}

function clearFailures(keys) {
  for (const key of keys) {
    if (!key.startsWith('ip:')) run('DELETE FROM login_throttle WHERE key = ?', key);
  }
}

/** Lifts all login locks for a user (CLI / admin password reset). */
export function unlockUser(username) {
  const name = String(username).trim().toLowerCase();
  run("DELETE FROM login_throttle WHERE key = ? OR key LIKE ? ESCAPE '\\'", `user:${name}`, `pair:${name.replace(/[\\%_]/g, '\\$&')}|%`);
}

/**
 * First login step. Result:
 *   { ok: true, user }
 *   { ok: false, reason: 'invalid' | 'inactive' }
 *   { ok: false, reason: 'locked', wait }   wait = seconds until the next try
 */
export async function attemptLogin({ username, password, ip }) {
  const keys = throttleKeys(username, ip);
  const wait = lockedSeconds(keys);
  if (wait > 0) return { ok: false, reason: 'locked', wait };

  const user = username ? findUserByUsername(username) : null;
  const valid = user ? await verifyPassword(password, user.password_hash) : await burnPasswordCheck(password);
  if (!valid) {
    registerFailure(keys);
    return { ok: false, reason: 'invalid' };
  }
  if (!user.active) return { ok: false, reason: 'inactive' };

  clearFailures(keys);
  if (needsRehash(user.password_hash)) {
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
  }
  return { ok: true, user };
}

/** Re-authentication for sensitive account changes; counts towards the same throttle. */
export async function confirmPassword(user, password, ip) {
  const keys = throttleKeys(user.username, ip);
  if (lockedSeconds(keys) > 0) return false;
  const valid = await verifyPassword(String(password ?? ''), user.password_hash);
  if (!valid) registerFailure(keys);
  return valid;
}

// --- Second factor ----------------------------------------------------------
// After a correct password, accounts with 2FA get a short-lived challenge
// instead of a session. Only a valid code turns it into a session.

export function createChallenge(userId, persistent) {
  const token = randomToken(32);
  run(
    'INSERT INTO login_challenges (id, user_id, persistent, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token),
    userId,
    persistent ? 1 : 0,
    iso(Date.now() + CHALLENGE_MS),
  );
  return token;
}

export function loadChallenge(token) {
  if (!token || token.length > 128) return null;
  const challenge = get('SELECT * FROM login_challenges WHERE id = ?', sha256(token));
  if (!challenge) return null;
  if (Date.parse(challenge.expires_at) <= Date.now() || challenge.attempts >= CHALLENGE_ATTEMPTS) {
    run('DELETE FROM login_challenges WHERE id = ?', challenge.id);
    return null;
  }
  return challenge;
}

export const destroyChallenge = (id) => run('DELETE FROM login_challenges WHERE id = ?', id);

/** Accepts a 6-digit authenticator code or an unused recovery code. */
function checkSecondFactor(user, code) {
  const text = String(code ?? '').trim();
  if (/^\d{6}$/.test(text.replace(/\s/g, ''))) {
    const secret = open(user.totp_secret);
    if (!secret) return false;
    const step = verifyTotp(secret, text, { afterStep: user.totp_last_step });
    if (step === null) return false;
    run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    return true;
  }
  if (normalizeRecoveryCode(text).length !== 10) return false;
  const used = run(
    'UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    now(),
    user.id,
    hashRecoveryCode(text),
  );
  return used.changes === 1;
}

/**
 * Second login step. Result: { ok: true, user } or
 * { ok: false, reason: 'invalid' | 'locked' | 'expired', wait? }.
 */
export function completeChallenge(challenge, code, ip) {
  const user = getUser(challenge.user_id);
  if (!user || !user.active || !user.totp_enabled) {
    destroyChallenge(challenge.id);
    return { ok: false, reason: 'expired' };
  }
  const keys = throttleKeys(user.username, ip);
  const wait = lockedSeconds(keys);
  if (wait > 0) return { ok: false, reason: 'locked', wait };

  if (!checkSecondFactor(user, code)) {
    registerFailure(keys);
    run('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?', challenge.id);
    return { ok: false, reason: challenge.attempts + 1 >= CHALLENGE_ATTEMPTS ? 'expired' : 'invalid' };
  }
  clearFailures(keys);
  destroyChallenge(challenge.id);
  return { ok: true, user };
}

/** Starts (or resumes) enrolment and returns the Base32 secret to show as QR code. */
export function pendingTotpSecret(user) {
  if (user.totp_enabled) return null;
  const existing = open(user.totp_secret);
  if (existing) return existing;
  const secret = generateSecret();
  run('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?', seal(secret), user.id);
  return secret;
}

function replaceRecoveryCodes(userId) {
  const codes = generateRecoveryCodes();
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  for (const code of codes) {
    run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, hashRecoveryCode(code));
  }
  return codes;
}

/** Activates 2FA once the user proved the app is set up. Returns recovery codes or null. */
export function confirmTotpEnrollment(user, code) {
  const secret = user.totp_enabled ? null : open(user.totp_secret);
  if (!secret) return null;
  const step = verifyTotp(secret, code);
  if (step === null) return null;
  run('UPDATE users SET totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?', step, now(), user.id);
  return replaceRecoveryCodes(user.id);
}

export function disableTotp(userId) {
  run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, updated_at = ? WHERE id = ?', now(), userId);
  run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
}

export const regenerateRecoveryCodes = (userId) => replaceRecoveryCodes(userId);

export const remainingRecoveryCodes = (userId) =>
  get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n;

// --- First-run setup --------------------------------------------------------
// The very first account is created in the browser. To make sure a stranger
// cannot do that on a freshly deployed server, the form requires a token that
// is only visible in the server log (or set via SETUP_TOKEN).

export function setupToken() {
  if (countUsers() > 0) return null;
  if (config.setupToken) return config.setupToken;
  let token = getSetting('setup_token');
  if (!token) {
    token = randomToken(18);
    setSetting('setup_token', token);
  }
  return token;
}

export const finishSetup = () => deleteSetting('setup_token');

export function cleanupExpired() {
  const timestamp = now();
  run('DELETE FROM sessions WHERE expires_at <= ?', timestamp);
  run('DELETE FROM login_challenges WHERE expires_at <= ?', timestamp);
  run('DELETE FROM login_throttle WHERE last_failure_at <= ?', iso(Date.now() - DAY));
}
