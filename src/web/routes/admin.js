// Admin: settings and activity log.
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { config } from '../../config.js';
import { getSetting, setSetting } from '../../services/settings.js';
import { listEvents, logEvent } from '../../services/events.js';
import { confirmPassword } from '../../services/auth.js';
import { createArchive, estimateSize } from '../../services/transfer.js';
import { cleanText, formatBytes } from '../../lib/format.js';
import { page } from '../layout.js';
import { clientIp, pageParam, publicOrigin, readForm, redirect, requireAdmin } from '../http.js';
import { icon } from '../icons.js';
import { alert, card, csrfField, details, emptyState, errorSummary, field, pageHeader, pagination } from '../ui.js';
import { timeline } from '../views/shared.js';

export const adminRoutes = new Hono();
adminRoutes.use('/einstellungen', requireAdmin);
adminRoutes.use('/aktivitaet', requireAdmin);

function backupCard(c, error = '') {
  return card({
    title: 'Datensicherung & Umzug',
    id: 'sicherung',
    body: html`<p>Die Komplettsicherung ist eine einzelne Datei mit allen Daten: Geräte, Prüfungen, Defekte, Fotos und Belege,
        Nutzerkonten sowie der Schlüssel für die Zwei-Faktor-Anmeldung. Damit lässt sich das Inventar vollständig auf einen
        anderen Server umziehen oder nach einem Ausfall wiederherstellen.</p>
      <p class="muted small">Einspielen: Auf dem neuen Server bei der Ersteinrichtung „Umzug: Komplettsicherung einspielen“ wählen.
        Behält der neue Server dieselbe Adresse (APP_URL), bleiben alle gedruckten QR-Etiketten gültig.</p>
      ${alert('Die Datei enthält sämtliche Daten einschließlich der Anmeldedaten aller Nutzer (Passwörter nur als nicht umkehrbarer Hash). Bitte so sorgfältig aufbewahren wie einen Generalschlüssel.', 'warning', 'shield')}
      <form method="post" action="/einstellungen/sicherung" class="form form--inline">
        ${csrfField(c)}
        ${field({ label: 'Dein Passwort zur Bestätigung', name: 'password', id: 'f-backup-password', type: 'password', required: true, error, attributes: { autocomplete: 'current-password' } })}
        <button type="submit" class="btn btn--primary">${icon('download', { size: 16 })}Komplettsicherung herunterladen</button>
      </form>
      <p class="muted small">Ungefähre Größe: ${formatBytes(estimateSize())} (vor der Komprimierung)</p>`,
  });
}

const currentSettings = () => ({ company_name: getSetting('company_name'), inventory_prefix: getSetting('inventory_prefix'), warn_days: getSetting('warn_days') });

function settingsPage(c, { values, errors = {}, backupError = '' }, status = 200) {
  const content = html`${pageHeader({ title: 'Einstellungen' })}
    <div class="stack">
      <form method="post" action="/einstellungen" class="card form form--page">
        ${csrfField(c)}
        ${errorSummary(errors)}
        ${field({ label: 'Firmenname', name: 'company_name', value: values.company_name, hint: 'Erscheint in der Kopfzeile und im Namen des 2FA-Eintrags.', attributes: { maxlength: 80 } })}
        ${field({ label: 'Präfix für Inventarnummern', name: 'inventory_prefix', value: values.inventory_prefix, error: errors.inventory_prefix, hint: 'Neue Geräte erhalten automatisch die nächste freie Nummer, z. B. INV-0042.', attributes: { maxlength: 12 } })}
        ${field({ label: 'Vorwarnzeit für Prüfungen (Tage)', name: 'warn_days', type: 'number', value: values.warn_days, error: errors.warn_days, hint: 'So viele Tage vor dem Termin gilt eine Prüfung als „bald fällig“.', attributes: { min: 0, max: 365 } })}
        <div class="form-actions"><button type="submit" class="btn btn--primary">Speichern</button></div>
      </form>
      ${card({
        title: 'System',
        body: html`${details([
            ['Adresse für QR-Codes', html`<span class="mono">${publicOrigin(c)}</span>`],
            ['Verschlüsselte Verbindung (HTTPS)', config.secureCookies ? 'aktiv' : html`<span class="text-warning">nicht konfiguriert</span>`],
            ['Maximale Dateigröße', formatBytes(config.maxUploadBytes)],
            ['Automatische Datensicherung', config.backupKeep > 0 ? `täglich, ${config.backupKeep} Stände werden aufbewahrt` : 'deaktiviert'],
          ])}
          ${config.secureCookies ? '' : alert(html`Für den Betrieb im Internet muss <strong>APP_URL</strong> auf eine https-Adresse gesetzt sein – erst dann werden Sitzungs-Cookies nur verschlüsselt übertragen. Die QR-Codes enthalten die oben angezeigte Adresse.`, 'warning', 'circle-alert')}`,
      })}
      ${backupCard(c, backupError)}
    </div>`;
  return page(c, { title: 'Einstellungen', active: 'settings', narrow: true, content }, status);
}

adminRoutes.get('/einstellungen', (c) => settingsPage(c, { values: currentSettings() }));

adminRoutes.post('/einstellungen/sicherung', requireAdmin, async (c) => {
  const user = c.get('user');
  if (!(await confirmPassword(user, (await readForm(c)).text('password'), clientIp(c)))) {
    return settingsPage(c, { values: currentSettings(), backupError: 'Das Passwort stimmt nicht.' }, 422);
  }
  const archive = await createArchive();
  const { assets, attachments, users } = archive.manifest.counts;
  logEvent({ user, action: 'backup.created', detail: `${assets} Geräte, ${users} Nutzer, ${attachments} Dateien` });
  return c.body(Readable.toWeb(archive.stream), 200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${archive.filename}"`,
  });
});

adminRoutes.post('/einstellungen', async (c) => {
  const input = (await readForm(c)).values();
  const errors = {};
  const prefix = cleanText(input.inventory_prefix, 12);
  const warnDays = Number.parseInt(input.warn_days, 10);
  if (!/^[\w./-]{0,12}$/.test(prefix)) errors.inventory_prefix = 'Erlaubt sind Buchstaben, Ziffern sowie - _ . /';
  if (!Number.isInteger(warnDays) || warnDays < 0 || warnDays > 365) errors.warn_days = 'Bitte eine Zahl zwischen 0 und 365 angeben.';
  if (Object.keys(errors).length > 0) return settingsPage(c, { values: input, errors }, 422);
  setSetting('company_name', cleanText(input.company_name, 80));
  setSetting('inventory_prefix', prefix);
  setSetting('warn_days', warnDays);
  logEvent({ user: c.get('user'), action: 'settings.updated' });
  return redirect(c, '/einstellungen', 'Einstellungen gespeichert.');
});

adminRoutes.get('/aktivitaet', (c) => {
  const pageNumber = pageParam(c);
  const pageSize = 50;
  const { rows, total } = listEvents({ limit: pageSize, offset: (pageNumber - 1) * pageSize });
  const content = html`${pageHeader({ title: 'Aktivität', subtitle: 'Wer hat wann was geändert' })}
    ${rows.length === 0 ? emptyState({ iconName: 'activity', title: 'Noch keine Einträge' }) : card({ body: timeline(rows, { showAsset: true }) })}
    ${pagination(c, { page: pageNumber, pageSize, total })}`;
  return page(c, { title: 'Aktivität', active: 'activity', narrow: true, content });
});
