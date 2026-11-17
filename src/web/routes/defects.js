// Defect reports: overview, quick report form, detail with status changes.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { getAsset } from '../../services/assets.js';
import { createDefect, defectCounts, deleteDefect, getDefect, listDefects, updateDefect, validateDefect } from '../../services/defects.js';
import { addAttachments, listAttachments } from '../../services/attachments.js';
import { DEFECT_STATUS, SEVERITY, SEVERITY_HINT } from '../../lib/terms.js';
import { formatAmount, formatDateTime, formatMoney, formatTimestampDate, plural } from '../../lib/format.js';
import { page } from '../layout.js';
import { idParam, isAdmin, notFound, pageParam, readForm, redirect, requireAdmin, withQuery } from '../http.js';
import { confirmation } from '../confirm.js';
import { icon } from '../icons.js';
import {
  card,
  choiceGroup,
  csrfField,
  defectStatusBadge,
  details,
  emptyState,
  errorSummary,
  field,
  fileField,
  pageHeader,
  pagination,
  postButton,
  select,
  severityBadge,
  tabs,
  textarea,
} from '../ui.js';
import { gallery } from '../views/shared.js';

const PAGE_SIZE = 50;
const SEVERITY_CHOICES = [
  { value: 'low', label: SEVERITY.low, hint: SEVERITY_HINT.low, tone: 'neutral' },
  { value: 'medium', label: SEVERITY.medium, hint: SEVERITY_HINT.medium, tone: 'warning' },
  { value: 'critical', label: SEVERITY.critical, hint: SEVERITY_HINT.critical, tone: 'danger' },
];

/** After a quick action started from a QR scan, return to the scan view. */
export const returnPath = (asset, origin) => (origin === 'scan' ? `/q/${asset.code}` : `/inventar/${asset.id}`);

function defectForm(c, asset, { values = {}, errors = {}, origin = '' }, status = 200) {
  const back = returnPath(asset, origin);
  const content = html`${pageHeader({ title: 'Defekt melden', subtitle: `${asset.inventory_number} · ${asset.name}`, back: { href: back, label: 'Zurück' } })}
    <form method="post" action="/inventar/${asset.id}/defekte" enctype="multipart/form-data" class="card form form--page">
      ${csrfField(c)}
      <input type="hidden" name="origin" value="${origin}" />
      ${errorSummary(errors)}
      ${field({ label: 'Was ist defekt?', name: 'title', value: values.title, required: true, error: errors.title, attributes: { maxlength: 150, autofocus: true, placeholder: 'z. B. Display flackert' } })}
      ${choiceGroup({ label: 'Schweregrad', name: 'severity', value: values.severity ?? 'medium', choices: SEVERITY_CHOICES, error: errors.severity, required: true })}
      ${textarea({ label: 'Beschreibung', name: 'description', value: values.description, rows: 4, hint: 'Optional: Was ist passiert? Wann tritt der Fehler auf?', attributes: { maxlength: 3000 } })}
      ${fileField({ label: 'Fotos', name: 'photos', accept: 'image/*', hint: 'Optional – am Handy direkt mit der Kamera aufnehmen.' })}
      <div class="form-actions form-actions--sticky">
        <a class="btn" href="${back}">Abbrechen</a>
        <button type="submit" class="btn btn--primary">${icon('triangle-alert', { size: 16 })}Defekt melden</button>
      </div>
    </form>`;
  return page(c, { title: 'Defekt melden', active: 'defects', narrow: true, content }, status);
}

function defectPage(c, defect, { errors = {}, input = null } = {}, status = 200) {
  const admin = isAdmin(c);
  const values = input ?? { ...defect, repair_cost: formatAmount(defect.repair_cost_cents) };
  const photos = listAttachments(defect.asset_id, c.get('user')).filter((file) => file.defect_id === defect.id);
  const content = html`${pageHeader({
      title: defect.title,
      subtitle: html`<a href="/inventar/${defect.asset_id}">${defect.inventory_number} · ${defect.asset_name}</a>`,
      back: { href: '/defekte', label: 'Defekte' },
      badges: html`${severityBadge(defect.severity)}${defectStatusBadge(defect.status)}`,
      actions: admin
        ? postButton(c, { action: `/defekte/${defect.id}/loeschen`, label: 'Löschen', iconName: 'trash-2', className: 'btn btn--danger', confirm: `Defektmeldung „${defect.title}“ endgültig löschen?` })
        : '',
    })}
    <div class="detail-grid">
      <div class="stack">
        ${card({
          title: 'Meldung',
          body: html`${details([
              ['Gemeldet', `${formatDateTime(defect.reported_at)}${defect.reported_by_name ? ` von ${defect.reported_by_name}` : ''}`],
              ['Standort', defect.location_name],
              ['Beschreibung', defect.description ? html`<span class="prewrap">${defect.description}</span>` : null],
              defect.status === 'resolved' ? ['Behoben', `${formatDateTime(defect.resolved_at)}${defect.resolved_by_name ? ` von ${defect.resolved_by_name}` : ''}`] : null,
              defect.resolution ? ['Maßnahme', html`<span class="prewrap">${defect.resolution}</span>`] : null,
              admin && defect.repair_cost_cents !== null ? ['Reparaturkosten', formatMoney(defect.repair_cost_cents)] : null,
            ])}
            ${gallery(c, photos, { canDelete: admin })}`,
        })}
      </div>
      <aside class="stack">
        ${card({
          title: 'Bearbeiten',
          body: html`<form method="post" action="/defekte/${defect.id}" enctype="multipart/form-data" class="form">
            ${csrfField(c)}
            ${errorSummary(errors)}
            ${select({ label: 'Status', name: 'status', value: values.status, options: Object.entries(DEFECT_STATUS).map(([value, label]) => ({ value, label })) })}
            ${textarea({ label: 'Maßnahme / Lösung', name: 'resolution', value: values.resolution, rows: 3, hint: 'Was wurde unternommen?', attributes: { maxlength: 3000 } })}
            ${admin
              ? html`${field({ label: 'Titel', name: 'title', value: values.title, required: true, error: errors.title, attributes: { maxlength: 150 } })}
                  ${select({ label: 'Schweregrad', name: 'severity', value: values.severity, options: Object.entries(SEVERITY).map(([value, label]) => ({ value, label })) })}
                  ${field({ label: 'Reparaturkosten (€)', name: 'repair_cost', value: values.repair_cost, error: errors.repair_cost, attributes: { inputmode: 'decimal', placeholder: '0,00' } })}`
              : ''}
            ${fileField({ label: 'Fotos ergänzen', name: 'photos', accept: 'image/*' })}
            <button type="submit" class="btn btn--primary btn--block">Speichern</button>
          </form>`,
        })}
      </aside>
    </div>`;
  return page(c, { title: defect.title, active: 'defects', content }, status);
}

export const defectRoutes = new Hono();

defectRoutes.get('/defekte', (c) => {
  const status = ['resolved', 'all'].includes(c.req.query('status')) ? c.req.query('status') : 'open';
  const filters = { status, severity: c.req.query('schwere') ?? '', q: c.req.query('q') ?? '' };
  const pageNumber = pageParam(c);
  const { rows, total } = listDefects(filters, { page: pageNumber, pageSize: PAGE_SIZE });
  const counts = defectCounts();
  const tab = (value, label, count) => ({ label, count, active: status === value, href: withQuery(c, { status: value === 'open' ? null : value, seite: null }) });

  const content = html`${pageHeader({ title: 'Defekte', subtitle: counts.critical > 0 ? `${plural(counts.critical, 'kritischer Defekt', 'kritische Defekte')} offen` : 'Gemeldete Mängel an Geräten' })}
    ${tabs([tab('open', 'Offen', counts.open), tab('resolved', 'Behoben', counts.resolved), tab('all', 'Alle')])}
    <form class="filters" method="get" action="/defekte" data-autosubmit>
      ${status !== 'open' ? html`<input type="hidden" name="status" value="${status}" />` : ''}
      <div class="search">${icon('search', { size: 16 })}<input class="input" type="search" name="q" value="${filters.q}" placeholder="Suchen nach Gerät oder Beschreibung …" aria-label="Suchen" autocomplete="off" /></div>
      <select class="input input--filter" name="schwere" aria-label="Schweregrad">
        <option value="">Schweregrad: alle</option>
        ${Object.entries(SEVERITY).map(([value, label]) => html`<option value="${value}"${filters.severity === value ? html` selected` : ''}>${label}</option>`)}
      </select>
      <noscript><button type="submit" class="btn">Filtern</button></noscript>
    </form>
    <div id="results">
      ${rows.length === 0
        ? emptyState({ iconName: 'circle-check', title: status === 'open' ? 'Keine offenen Defekte' : 'Keine Einträge', text: 'Defekte lassen sich am schnellsten per QR-Code am Gerät melden.' })
        : html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Defekt</th><th class="hide-sm">Gerät</th><th class="hide-sm">Schwere</th><th class="hide-sm">Status</th><th class="hide-md">Gemeldet</th></tr></thead>
            <tbody>
              ${rows.map(
                (defect) => html`<tr>
                  <td class="table__primary"><a href="/defekte/${defect.id}">${defect.title}</a>
                    <span class="cell-sub show-sm">${defect.inventory_number} · ${defect.asset_name}</span>
                    <div class="badges show-sm">${severityBadge(defect.severity)}${defectStatusBadge(defect.status)}</div></td>
                  <td class="hide-sm"><a class="link-plain" href="/inventar/${defect.asset_id}">${defect.asset_name}</a><span class="cell-sub">${defect.inventory_number}</span></td>
                  <td class="hide-sm">${severityBadge(defect.severity)}</td>
                  <td class="hide-sm">${defectStatusBadge(defect.status)}</td>
                  <td class="hide-md nowrap">${formatTimestampDate(defect.reported_at)}<span class="cell-sub">${defect.reported_by_name ?? ''}</span></td>
                </tr>`,
              )}
            </tbody>
          </table></div>${pagination(c, { page: pageNumber, pageSize: PAGE_SIZE, total })}`}
    </div>`;
  return page(c, { title: 'Defekte', active: 'defects', content });
});

defectRoutes.get('/inventar/:id{[0-9]+}/defekt/neu', (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  return defectForm(c, asset, { origin: c.req.query('von') === 'scan' ? 'scan' : '' });
});

defectRoutes.post('/inventar/:id{[0-9]+}/defekte', async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const form = await readForm(c);
  const origin = form.text('origin') === 'scan' ? 'scan' : '';
  const { values, errors } = validateDefect(form.values());
  if (Object.keys(errors).length > 0) return defectForm(c, asset, { values: form.values(), errors, origin }, 422);

  const user = c.get('user');
  const defectId = createDefect(asset, values, user);
  const upload = await addAttachments(form.files('photos'), { asset, user, kind: 'photo', defectId });
  if (upload.errors.length > 0) {
    return redirect(c, `/defekte/${defectId}`, `Defekt gemeldet, aber: ${upload.errors.join(' ')}`, 'error');
  }
  return redirect(c, returnPath(asset, origin), 'Defekt gemeldet. Danke!');
});

defectRoutes.get('/defekte/:id{[0-9]+}', (c) => {
  const defect = getDefect(idParam(c));
  if (!defect) throw notFound('Diese Defektmeldung gibt es nicht (mehr).');
  return defectPage(c, defect);
});

defectRoutes.post('/defekte/:id{[0-9]+}', async (c) => {
  const defect = getDefect(idParam(c));
  if (!defect) throw notFound();
  const form = await readForm(c);
  const user = c.get('user');
  const errors = updateDefect(defect, form.values(), user);
  if (Object.keys(errors).length > 0) return defectPage(c, defect, { errors, input: form.values() }, 422);
  const asset = getAsset(defect.asset_id);
  const upload = await addAttachments(form.files('photos'), { asset, user, kind: 'photo', defectId: defect.id });
  if (upload.errors.length > 0) return redirect(c, `/defekte/${defect.id}`, upload.errors.join(' '), 'error');
  return redirect(c, `/defekte/${defect.id}`, 'Defekt aktualisiert.');
});

defectRoutes.post('/defekte/:id{[0-9]+}/loeschen', requireAdmin, async (c) => {
  const defect = getDefect(idParam(c));
  if (!defect) throw notFound();
  const pending = await confirmation(c, { title: 'Defekt löschen', message: `Defektmeldung „${defect.title}“ endgültig löschen?`, cancel: `/defekte/${defect.id}` });
  if (pending) return pending;
  deleteDefect(defect, c.get('user'));
  return redirect(c, '/defekte', 'Defektmeldung gelöscht.');
});
