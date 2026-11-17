// Application settings stored as key/value pairs.
import { all, run } from '../db.js';

const DEFAULTS = {
  company_name: '',
  /** Days before the due date from which an inspection counts as "bald fällig". */
  warn_days: '30',
  inventory_prefix: 'INV-',
  /** Small line on QR labels, e.g. "Eigentum der Muster GmbH". */
  label_footer: '',
  label_format: '',
};

let cache = null;

function load() {
  if (!cache) {
    cache = { ...DEFAULTS };
    for (const row of all('SELECT key, value FROM settings')) cache[row.key] = row.value;
  }
  return cache;
}

export function getSetting(key) {
  return load()[key] ?? '';
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
  cache = null;
}

export function deleteSetting(key) {
  run('DELETE FROM settings WHERE key = ?', key);
  cache = null;
}

export const companyName = () => getSetting('company_name');

export function warnDays() {
  const days = Number.parseInt(getSetting('warn_days'), 10);
  return Number.isFinite(days) && days >= 0 ? days : 30;
}
