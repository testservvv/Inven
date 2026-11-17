// Admin: settings and activity log.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { config } from '../../config.js';
import { getSetting, setSetting } from '../../services/settings.js';
import { listEvents, logEvent } from '../../services/events.js';
import { cleanText, formatBytes } from '../../lib/format.js';
import { page } from '../layout.js';
import { pageParam, publicOrigin, readForm, redirect, requireAdmin } from '../http.js';
import { alert, card, csrfField, details, emptyState, errorSummary, field, pageHeader, pagination } from '../ui.js';
import { timeline } from '../views/shared.js';

export const adminRoutes = new Hono();
adminRoutes.use('/einstellungen', requireAdmin);
adminRoutes.use('/aktivitaet', requireAdmin);

function settingsPage(c, { values, errors = {} }, status = 200) {
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
    </div>`;
  return page(c, { title: 'Einstellungen', active: 'settings', narrow: true, content }, status);
}

adminRoutes.get('/einstellungen', (c) =>
  settingsPage(c, { values: { company_name: getSetting('company_name'), inventory_prefix: getSetting('inventory_prefix'), warn_days: getSetting('warn_days') } }),
);

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
