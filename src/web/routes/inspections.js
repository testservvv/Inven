// Inspections: status overview, log of performed inspections, quick entry form.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { getAsset } from '../../services/assets.js';
import {
  deleteInspection,
  getInspection,
  intervalFor,
  lastInspector,
  listAssetPlans,
  listInspections,
  listPlans,
  planCounts,
  recordInspection,
  validateInspection,
} from '../../services/inspections.js';
import { listInspectionTypes } from '../../services/masterdata.js';
import { createDefect } from '../../services/defects.js';
import { addAttachments } from '../../services/attachments.js';
import { RESULT } from '../../lib/terms.js';
import { formatDate, today } from '../../lib/format.js';
import { page } from '../layout.js';
import { idParam, isAdmin, notFound, pageParam, readForm, redirect, requireAdmin, withQuery } from '../http.js';
import { confirmation } from '../confirm.js';
import { icon } from '../icons.js';
import {
  checkbox,
  choiceGroup,
  csrfField,
  dueText,
  emptyState,
  errorSummary,
  field,
  fileField,
  pageHeader,
  pagination,
  planBadge,
  resultBadge,
  select,
  tabs,
  textarea,
} from '../ui.js';
import { returnPath } from './defects.js';

const PAGE_SIZE = 50;
const RESULT_CHOICES = [
  { value: 'passed', label: RESULT.passed, tone: 'success' },
  { value: 'remarks', label: RESULT.remarks, hint: 'Nutzbar, Hinweise siehe Bemerkung', tone: 'warning' },
  { value: 'failed', label: RESULT.failed, hint: 'Gerät darf nicht verwendet werden', tone: 'danger' },
];

function inspectionForm(c, asset, { values, errors = {}, origin = '' }, status = 200) {
  const back = returnPath(asset, origin);
  const types = listInspectionTypes();
  // Interval per type, so the browser can suggest the next due date.
  const intervals = Object.fromEntries(types.map((type) => [type.id, intervalFor(asset.id, type.id)]));
  const content = html`${pageHeader({ title: 'Prüfung eintragen', subtitle: `${asset.inventory_number} · ${asset.name}`, back: { href: back, label: 'Zurück' } })}
    <form method="post" action="/inventar/${asset.id}/pruefungen" enctype="multipart/form-data" class="card form form--page" data-inspection-form data-intervals="${JSON.stringify(intervals)}">
      ${csrfField(c)}
      <input type="hidden" name="origin" value="${origin}" />
      ${errorSummary(errors)}
      <div class="form-grid">
        ${select({ label: 'Prüfart', name: 'type_id', value: values.type_id, required: true, error: errors.type_id, placeholder: types.length === 1 ? undefined : '– bitte wählen –', options: types.map((type) => ({ value: type.id, label: type.name })) })}
        ${field({ label: 'Prüfdatum', name: 'performed_on', type: 'date', value: values.performed_on, required: true, error: errors.performed_on, attributes: { max: today() } })}
      </div>
      ${choiceGroup({ label: 'Ergebnis', name: 'result', value: values.result ?? 'passed', choices: RESULT_CHOICES, error: errors.result, required: true })}
      <div class="form-grid">
        ${field({ label: 'Nächste Prüfung fällig am', name: 'next_due', type: 'date', value: values.next_due, error: errors.next_due, hint: 'Leer lassen = Prüfdatum + Intervall' })}
        ${field({ label: 'Prüfer / Prüfstelle', name: 'inspector', value: values.inspector, attributes: { maxlength: 100, autocomplete: 'off' } })}
        ${field({ label: 'Zertifikat- / Protokoll-Nr.', name: 'certificate_number', value: values.certificate_number, attributes: { maxlength: 80 } })}
      </div>
      ${textarea({ label: 'Bemerkung', name: 'notes', value: values.notes, rows: 3, attributes: { maxlength: 2000 } })}
      ${fileField({ label: 'Protokoll / Kalibrierschein', name: 'files', hint: 'Optional – PDF oder Foto des Nachweises.' })}
      ${checkbox({ label: 'Bei „Nicht bestanden“ automatisch einen kritischen Defekt anlegen', name: 'create_defect', checked: values.create_defect !== '0' })}
      <div class="form-actions form-actions--sticky">
        <a class="btn" href="${back}">Abbrechen</a>
        <button type="submit" class="btn btn--primary">${icon('check', { size: 16 })}Prüfung speichern</button>
      </div>
    </form>`;
  return page(c, { title: 'Prüfung eintragen', active: 'inspections', narrow: true, content }, status);
}

function statusView(c) {
  const state = ['action', 'overdue', 'soon', 'ok'].includes(c.req.query('stand')) ? c.req.query('stand') : '';
  const filters = { state, type: c.req.query('art') ?? '', q: c.req.query('q') ?? '' };
  const pageNumber = pageParam(c);
  const { rows, total } = listPlans(filters, { page: pageNumber, pageSize: PAGE_SIZE });
  const counts = planCounts();
  const tab = (value, label, count) => ({ label, count, active: state === value, href: withQuery(c, { stand: value || null, seite: null }) });

  return html`${tabs([
      tab('', 'Alle', counts.total),
      tab('overdue', 'Überfällig', counts.overdue + counts.failed),
      tab('soon', 'Bald fällig', counts.soon + counts.open),
      tab('ok', 'In Ordnung', counts.ok),
    ])}
    <form class="filters" method="get" action="/pruefungen" data-autosubmit>
      ${state ? html`<input type="hidden" name="stand" value="${state}" />` : ''}
      <div class="search">${icon('search', { size: 16 })}<input class="input" type="search" name="q" value="${filters.q}" placeholder="Suchen nach Gerät …" aria-label="Suchen" autocomplete="off" /></div>
      ${typeFilter(filters.type)}
      <noscript><button type="submit" class="btn">Filtern</button></noscript>
    </form>
    <div id="results">
      ${rows.length === 0
        ? emptyState({ iconName: 'clipboard-check', title: 'Keine Prüfungen in dieser Ansicht', text: 'Prüfpflichten werden pro Gerät auf dessen Detailseite hinterlegt.' })
        : html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Gerät</th><th class="hide-sm">Prüfart</th><th class="hide-sm">Stand</th><th class="hide-sm">Fällig</th><th class="hide-md">Letzte Prüfung</th><th></th></tr></thead>
            <tbody>
              ${rows.map(
                (plan) => html`<tr>
                  <td class="table__primary"><a href="/inventar/${plan.asset_id}#pruefungen">${plan.asset_name}</a><span class="cell-sub">${plan.inventory_number}${plan.location_name ? ` · ${plan.location_name}` : ''}</span>
                    <span class="cell-sub show-sm">${plan.type_name} · ${dueText(plan.next_due)}</span>
                    <div class="badges show-sm">${planBadge(plan.state)}</div></td>
                  <td class="hide-sm">${plan.type_name}<span class="cell-sub">alle ${plan.interval_months} Monate</span></td>
                  <td class="hide-sm">${planBadge(plan.state)}</td>
                  <td class="nowrap hide-sm">${dueText(plan.next_due)}</td>
                  <td class="hide-md nowrap">${plan.last_performed_on ? html`${formatDate(plan.last_performed_on)}<span class="cell-sub">${RESULT[plan.last_result]}</span>` : html`<span class="muted">noch nie</span>`}</td>
                  <td class="table__actions"><a class="btn btn--sm" href="/inventar/${plan.asset_id}/pruefung/neu?typ=${plan.type_id}">Eintragen</a></td>
                </tr>`,
              )}
            </tbody>
          </table></div>${pagination(c, { page: pageNumber, pageSize: PAGE_SIZE, total })}`}
    </div>`;
}

function typeFilter(current) {
  return html`<select class="input input--filter" name="art" aria-label="Prüfart">
    <option value="">Prüfart: alle</option>
    ${listInspectionTypes().map((type) => html`<option value="${type.id}"${String(type.id) === current ? html` selected` : ''}>${type.name}</option>`)}
  </select>`;
}

function logView(c) {
  const filters = { type: c.req.query('art') ?? '', q: c.req.query('q') ?? '' };
  const pageNumber = pageParam(c);
  const { rows, total } = listInspections(filters, { page: pageNumber, pageSize: PAGE_SIZE });
  return html`<form class="filters" method="get" action="/pruefungen" data-autosubmit>
      <input type="hidden" name="ansicht" value="protokoll" />
      <div class="search">${icon('search', { size: 16 })}<input class="input" type="search" name="q" value="${filters.q}" placeholder="Suchen nach Gerät, Prüfer, Zertifikat …" aria-label="Suchen" autocomplete="off" /></div>
      ${typeFilter(filters.type)}
      <noscript><button type="submit" class="btn">Filtern</button></noscript>
    </form>
    <div id="results">
      ${rows.length === 0
        ? emptyState({ iconName: 'history', title: 'Noch keine Prüfungen eingetragen' })
        : html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Datum</th><th>Gerät</th><th class="hide-sm">Prüfart</th><th>Ergebnis</th><th class="hide-md">Prüfer</th><th class="hide-md">Zertifikat</th><th class="hide-sm">Eingetragen von</th></tr></thead>
            <tbody>
              ${rows.map(
                (item) => html`<tr>
                  <td class="nowrap">${formatDate(item.performed_on)}</td>
                  <td class="table__primary"><a href="/inventar/${item.asset_id}#pruefungen">${item.asset_name}</a><span class="cell-sub">${item.inventory_number}</span><span class="cell-sub show-sm">${item.type_name}</span></td>
                  <td class="hide-sm">${item.type_name}</td>
                  <td>${resultBadge(item.result)}</td>
                  <td class="hide-md">${item.inspector ?? html`<span class="muted">–</span>`}</td>
                  <td class="hide-md">${item.certificate_number ?? html`<span class="muted">–</span>`}</td>
                  <td class="hide-sm">${item.created_by_name ?? html`<span class="muted">–</span>`}</td>
                </tr>`,
              )}
            </tbody>
          </table></div>${pagination(c, { page: pageNumber, pageSize: PAGE_SIZE, total })}`}
    </div>`;
}

export const inspectionRoutes = new Hono();

inspectionRoutes.get('/pruefungen', (c) => {
  const log = c.req.query('ansicht') === 'protokoll';
  const content = html`${pageHeader({
      title: 'Prüfungen',
      subtitle: 'Kalibrierungen, Elektroprüfungen und Wartungen im Blick',
      actions: html`<div class="segmented">
          <a class="segmented__item${log ? '' : ' segmented__item--active'}" href="/pruefungen">Stand</a>
          <a class="segmented__item${log ? ' segmented__item--active' : ''}" href="/pruefungen?ansicht=protokoll">Protokoll</a>
        </div>
        ${isAdmin(c) ? html`<a class="btn" href="/export/${log ? 'pruefprotokoll' : 'pruefungen'}.csv">${icon('download', { size: 16 })}CSV-Export</a>` : ''}`,
    })}
    ${log ? logView(c) : statusView(c)}`;
  return page(c, { title: 'Prüfungen', active: 'inspections', content });
});

inspectionRoutes.get('/inventar/:id{[0-9]+}/pruefung/neu', (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const types = listInspectionTypes();
  const plans = listAssetPlans(asset.id);
  // Preselect the requested type, else the device's only (or most urgent) plan.
  const requested = types.find((type) => String(type.id) === c.req.query('typ'));
  const typeId = requested?.id ?? [...plans].sort((a, b) => b.rank - a.rank)[0]?.type_id ?? (types.length === 1 ? types[0].id : '');
  return inspectionForm(c, asset, {
    origin: c.req.query('von') === 'scan' ? 'scan' : '',
    values: { type_id: typeId, performed_on: today(), result: 'passed', inspector: typeId ? lastInspector(asset.id, typeId) : '' },
  });
});

inspectionRoutes.post('/inventar/:id{[0-9]+}/pruefungen', async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const form = await readForm(c);
  const input = form.values();
  const origin = input.origin === 'scan' ? 'scan' : '';
  const { values, errors } = validateInspection(input, asset.id);
  if (Object.keys(errors).length > 0) {
    return inspectionForm(c, asset, { values: { ...input, create_defect: form.has('create_defect') ? '1' : '0' }, errors, origin }, 422);
  }
  const user = c.get('user');
  const inspectionId = recordInspection(asset, values, user);
  if (values.result === 'failed' && form.has('create_defect')) {
    createDefect(asset, { title: `${values.type_name} nicht bestanden`, description: values.notes, severity: 'critical' }, user);
  }
  const upload = await addAttachments(form.files('files'), { asset, user, kind: 'report', inspectionId });
  if (upload.errors.length > 0) {
    return redirect(c, `/inventar/${asset.id}#pruefungen`, `Prüfung gespeichert, aber: ${upload.errors.join(' ')}`, 'error');
  }
  return redirect(c, returnPath(asset, origin), `${values.type_name} eingetragen – nächste Fälligkeit ${formatDate(values.next_due)}.`);
});

inspectionRoutes.post('/pruefungen/:id{[0-9]+}/loeschen', requireAdmin, async (c) => {
  const inspection = getInspection(idParam(c));
  if (!inspection) throw notFound();
  const asset = getAsset(inspection.asset_id);
  const pending = await confirmation(c, {
    title: 'Prüfeintrag löschen',
    message: `Prüfeintrag „${inspection.type_name}“ vom ${formatDate(inspection.performed_on)} löschen?`,
    cancel: `/inventar/${asset.id}`,
  });
  if (pending) return pending;
  deleteInspection(inspection, asset, c.get('user'));
  return redirect(c, `/inventar/${asset.id}#pruefungen`, 'Prüfeintrag gelöscht.');
});
