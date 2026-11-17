// Activity log: who did what to which device. Names are stored alongside the
// ids so entries stay readable after a user or device has been deleted.
import { all, get, now, run } from '../db.js';

export const ACTION_LABEL = {
  'asset.created': 'Gerät angelegt',
  'asset.updated': 'Gerät bearbeitet',
  'asset.deleted': 'Gerät gelöscht',
  'asset.imported': 'Gerät importiert',
  'defect.reported': 'Defekt gemeldet',
  'defect.updated': 'Defekt aktualisiert',
  'defect.resolved': 'Defekt behoben',
  'defect.reopened': 'Defekt wieder geöffnet',
  'defect.deleted': 'Defekt gelöscht',
  'inspection.recorded': 'Prüfung eingetragen',
  'inspection.deleted': 'Prüfeintrag gelöscht',
  'plan.saved': 'Prüfplan gespeichert',
  'plan.removed': 'Prüfplan entfernt',
  'attachment.added': 'Datei hochgeladen',
  'attachment.removed': 'Datei gelöscht',
  'user.created': 'Nutzer angelegt',
  'user.updated': 'Nutzer geändert',
  'user.password_reset': 'Passwort zurückgesetzt',
  'user.2fa_reset': 'Zwei-Faktor-Schutz zurückgesetzt',
  'user.deleted': 'Nutzer gelöscht',
  'auth.login': 'Anmeldung',
  'auth.password_changed': 'Passwort geändert',
  'auth.2fa_enabled': 'Zwei-Faktor-Schutz aktiviert',
  'auth.2fa_disabled': 'Zwei-Faktor-Schutz deaktiviert',
  'import.completed': 'CSV-Import',
  'settings.updated': 'Einstellungen geändert',
  'masterdata.updated': 'Stammdaten geändert',
};

/**
 * @param {object} event
 * @param {{id: number, name: string} | null} event.user
 * @param {{id: number, inventory_number: string, name: string} | null} [event.asset]
 * @param {string} event.action  key of ACTION_LABEL
 * @param {string} [event.detail] human readable German text
 */
export function logEvent({ user, asset = null, action, detail = '' }) {
  run(
    'INSERT INTO events (asset_id, asset_label, user_id, user_name, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    asset?.id ?? null,
    asset ? `${asset.inventory_number} · ${asset.name}` : null,
    user?.id ?? null,
    user?.name ?? null,
    action,
    detail || null,
    now(),
  );
}

export function listAssetEvents(assetId, limit = 30) {
  return all('SELECT * FROM events WHERE asset_id = ? ORDER BY id DESC LIMIT ?', assetId, limit);
}

export function listEvents({ limit = 50, offset = 0 } = {}) {
  return {
    rows: all('SELECT * FROM events ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset),
    total: get('SELECT COUNT(*) AS n FROM events').n,
  };
}
