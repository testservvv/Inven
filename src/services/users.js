// User accounts.
import { all, get, now, run, tx } from '../db.js';
import { hashPassword, passwordProblem } from '../lib/security.js';
import { cleanText } from '../lib/format.js';

export const countUsers = () => get('SELECT COUNT(*) AS n FROM users').n;

export const getUser = (id) => get('SELECT * FROM users WHERE id = ?', id);

export const findUserByUsername = (username) => get('SELECT * FROM users WHERE username = ?', String(username).trim());

export function listUsers() {
  return all(
    `SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS session_count
     FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE`,
    now(),
  );
}

const activeAdmins = () => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;

/** Validates the profile fields; returns { values, errors }. */
export function validateProfile(input, { ignoreId = null } = {}) {
  const errors = {};
  const values = {
    name: cleanText(input.name, 80),
    username: cleanText(input.username, 64),
    role: input.role === 'admin' ? 'admin' : 'member',
  };
  if (!values.name) errors.name = 'Bitte einen Namen angeben.';
  if (!/^[A-Za-z0-9._@+-]{3,64}$/.test(values.username)) {
    errors.username = 'Erlaubt sind 3–64 Zeichen: Buchstaben (ohne Umlaute), Ziffern sowie . _ - @ +';
  } else {
    const existing = findUserByUsername(values.username);
    if (existing && existing.id !== ignoreId) errors.username = 'Dieser Benutzername ist bereits vergeben.';
  }
  return { values, errors };
}

export async function createUser({ username, name, role, password, mustChangePassword = false }) {
  const hash = await hashPassword(password);
  const timestamp = now();
  const result = run(
    `INSERT INTO users (username, name, role, password_hash, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    username,
    name,
    role,
    hash,
    mustChangePassword ? 1 : 0,
    timestamp,
    timestamp,
  );
  return getUser(result.lastInsertRowid);
}

/**
 * Updates name, username, role and active flag. Refuses changes that would
 * leave the installation without an active administrator.
 * Returns an error message or null.
 */
export function updateUser(id, { name, username, role, active }) {
  return tx(() => {
    const user = getUser(id);
    if (!user) return 'Nutzer nicht gefunden.';
    const losesAdmin = user.role === 'admin' && user.active && (role !== 'admin' || !active);
    if (losesAdmin && activeAdmins() <= 1) {
      return 'Es muss mindestens ein aktiver Administrator vorhanden bleiben.';
    }
    run(
      'UPDATE users SET name = ?, username = ?, role = ?, active = ?, updated_at = ? WHERE id = ?',
      name,
      username,
      role,
      active ? 1 : 0,
      now(),
      id,
    );
    if (!active) run('DELETE FROM sessions WHERE user_id = ?', id);
    return null;
  });
}

export function renameSelf(id, name) {
  run('UPDATE users SET name = ?, updated_at = ? WHERE id = ?', name, now(), id);
}

export async function setPassword(id, password, { mustChangePassword = false } = {}) {
  const hash = await hashPassword(password);
  run(
    'UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?',
    hash,
    mustChangePassword ? 1 : 0,
    now(),
    id,
  );
}

/** Returns an error message or null. */
export function deleteUser(id) {
  return tx(() => {
    const user = getUser(id);
    if (!user) return 'Nutzer nicht gefunden.';
    if (user.role === 'admin' && user.active && activeAdmins() <= 1) {
      return 'Der letzte aktive Administrator kann nicht gelöscht werden.';
    }
    run('DELETE FROM users WHERE id = ?', id);
    return null;
  });
}

export { passwordProblem };
