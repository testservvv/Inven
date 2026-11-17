// Inventory: list, detail, create/edit, files and inspection plans of a device.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { get } from '../../db.js';
import {
  ASSET_SORTS,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  nextInventoryNumber,
  updateAsset,
  validateAsset,
} from '../../services/assets.js';
import {
  ensureCategory,
  ensureLocation,
  getInspectionType,
  listCategories,
  listInspectionTypes,
  listLocations,
  listPolicies,
  parseInterval,
} from '../../services/masterdata.js';
import { getPlan, listAssetInspections, listAssetPlans, removePlan, savePlan, validatePlan } from '../../services/inspections.js';
import { listAssetDefects } from '../../services/defects.js';
import { addAttachments, coverPhoto, deleteAttachment, getAttachment, listAttachments } from '../../services/attachments.js';
import { listAssetEvents } from '../../services/events.js';
import { ASSET_STATUS, ATTACHMENT_KIND, OWNERSHIP } from '../../lib/terms.js';
import { formatAmount, formatMoney, parseDate, plural } from '../../lib/format.js';
import { qrSvg } from '../../lib/qr.js';
import { page } from '../layout.js';
import { idParam, isAdmin, notFound, pageParam, publicOrigin, readForm, redirect, requireAdmin, withQuery } from '../http.js';
import { confirmation } from '../confirm.js';
import { icon } from '../icons.js';
import {
  assetStatusBadge,
  checkbox,
  conditionBadges,
  csrfField,
  dueText,
  emptyState,
  errorSummary,
  field,
  pageHeader,
  pagination,
  select,
  sortHeader,
  textarea,
} from '../ui.js';
import { assetDetail } from '../views/asset-detail.js';

const PAGE_SIZE = 50;

/** Filters as they appear in the query string (German names) → service filters. */
export function assetFilters(c) {
  return {
    q: c.req.query('q') ?? '',
    category: c.req.query('kategorie') ?? '',
    location: c.req.query('standort') ?? '',
    policy: c.req.query('versicherung') ?? '',
    status: c.req.query('status') ?? '',
    condition: c.req.query('zustand') ?? '',
  };
}

export function assetSort(c) {
  const sort = ASSET_SORTS.includes(c.req.query('sort')) ? c.req.query('sort') : 'inv';
  return { sort, dir: c.req.query('dir') === 'desc' ? 'desc' : 'asc' };
}

const options = (rows, extra = []) => [...rows.map((row) => ({ value: row.id, label: row.name })), ...extra];

function assetList(c) {
  const admin = isAdmin(c);
  const filters = assetFilters(c);
  const { sort, dir } = assetSort(c);
  const pageNumber = pageParam(c);
  const { rows, total, value } = listAssets(filters, { sort, dir, page: pageNumber, pageSize: PAGE_SIZE });
  const filtered = Object.values(filters).some(Boolean);
  const sorting = { current: sort, direction: dir };
  const exportUrl = withQuery(c, { seite: null }).replace(/^\/inventar/, '/export/inventar.csv');

  const filterSelect = (name, label, items, current) => html`<select class="input input--filter" name="${name}" aria-label="${label}">
      <option value="">${label}: alle</option>
      ${items.map((item) => html`<option value="${item.value}"${String(item.value) === current ? html` selected` : ''}>${item.label}</option>`)}
    </select>`;

  const table = html`<form method="get" action="/etiketten" data-bulk>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              ${admin ? html`<th class="table__check hide-sm"><input type="checkbox" data-check-all aria-label="Alle auswählen" /></th>` : ''}
              ${sortHeader(c, 'inv', 'Inv.-Nr.', { ...sorting, className: 'hide-sm' })}
              ${sortHeader(c, 'name', 'Bezeichnung', sorting)}
              ${sortHeader(c, 'category', 'Kategorie', { ...sorting, className: 'hide-md' })}
              ${sortHeader(c, 'location', 'Standort', { ...sorting, className: 'hide-sm' })}
              ${sortHeader(c, 'serial', 'Seriennummer', { ...sorting, className: 'hide-lg' })}
              <th class="hide-sm">Zustand</th>
              ${sortHeader(c, 'due', 'Nächste Prüfung', { ...sorting, className: 'hide-md' })}
              ${admin ? sortHeader(c, 'value', 'Wert', { ...sorting, className: 'hide-lg table__number' }) : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (asset) => html`<tr class="${asset.status === 'retired' || asset.status === 'lost' ? 'row--muted' : ''}">
                ${admin ? html`<td class="table__check hide-sm"><input type="checkbox" name="ids" value="${asset.id}" aria-label="${asset.inventory_number} auswählen" /></td>` : ''}
                <td class="nowrap mono hide-sm">${asset.inventory_number}</td>
                <td class="table__primary">
                  <a href="/inventar/${asset.id}">${asset.name}</a>
                  <span class="cell-sub">${[asset.manufacturer, asset.model].filter(Boolean).join(' ') || ''}</span>
                  <span class="cell-sub show-sm">${[asset.inventory_number, asset.location_name].filter(Boolean).join(' · ')}</span>
                  <div class="badges show-sm">${asset.status !== 'active' ? assetStatusBadge(asset.status) : ''}${conditionBadges(asset)}</div>
                </td>
                <td class="hide-md">${asset.category_name ?? html`<span class="muted">–</span>`}</td>
                <td class="hide-sm">${asset.location_name ?? html`<span class="muted">–</span>`}${asset.location_detail ? html`<span class="cell-sub">${asset.location_detail}</span>` : ''}</td>
                <td class="hide-lg mono">${asset.serial_number ?? html`<span class="muted">–</span>`}</td>
                <td class="hide-sm"><div class="badges">${asset.status !== 'active' ? assetStatusBadge(asset.status) : ''}${conditionBadges(asset)}</div></td>
                <td class="hide-md nowrap">${asset.next_due ? dueText(asset.next_due) : html`<span class="muted">–</span>`}</td>
                ${admin ? html`<td class="hide-lg table__number nowrap">${asset.value_cents !== null ? formatMoney(asset.value_cents) : html`<span class="muted">–</span>`}</td>` : ''}
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${admin
        ? html`<div class="bulk-bar" data-bulk-bar hidden>
            <span data-bulk-count>0 ausgewählt</span>
            <button type="submit" class="btn btn--sm btn--primary">${icon('qr-code', { size: 16 })}Etiketten drucken</button>
          </div>`
        : ''}
    </form>`;

  const content = html`${pageHeader({
      title: 'Inventar',
      subtitle: `${plural(total, 'Gerät', 'Geräte')}${admin && value > 0 ? ` · Gesamtwert ${formatMoney(value)}` : ''}${filtered ? ' (gefiltert)' : ''}`,
      actions: admin
        ? html`<a class="btn" href="${exportUrl}">${icon('download', { size: 16 })}CSV-Export</a>
            <a class="btn btn--primary" href="/inventar/neu">${icon('plus', { size: 16 })}Gerät hinzufügen</a>`
        : '',
    })}
    <form class="filters" method="get" action="/inventar" data-autosubmit>
      <div class="search">
        ${icon('search', { size: 16 })}
        <input class="input" type="search" name="q" value="${filters.q}" placeholder="Suchen nach Name, Nummer, Seriennummer …" aria-label="Suchen" autocomplete="off" />
      </div>
      ${filterSelect('kategorie', 'Kategorie', options(listCategories(), [{ value: 'none', label: '(ohne Kategorie)' }]), filters.category)}
      ${filterSelect('standort', 'Standort', options(listLocations(), [{ value: 'none', label: '(ohne Standort)' }]), filters.location)}
      ${filterSelect('status', 'Status', [{ value: 'stock', label: 'Im Bestand' }, ...Object.entries(ASSET_STATUS).map(([v, label]) => ({ value: v, label }))], filters.status)}
      ${filterSelect('zustand', 'Zustand', [
        { value: 'defect', label: 'Mit offenem Defekt' },
        { value: 'due', label: 'Prüfung fällig / bald fällig' },
        { value: 'overdue', label: 'Prüfung überfällig' },
        { value: 'ok', label: 'In Ordnung' },
      ], filters.condition)}
      ${admin ? filterSelect('versicherung', 'Versicherung', options(listPolicies(), [{ value: 'none', label: '(nicht versichert)' }]), filters.policy) : ''}
      <input type="hidden" name="sort" value="${sort}" /><input type="hidden" name="dir" value="${dir}" />
      <noscript><button type="submit" class="btn">Filtern</button></noscript>
      ${filtered ? html`<a class="btn btn--ghost" href="/inventar">${icon('x', { size: 16 })}Zurücksetzen</a>` : ''}
    </form>
    <div id="results">
      ${rows.length > 0
        ? html`${table}${pagination(c, { page: pageNumber, pageSize: PAGE_SIZE, total })}`
        : emptyState(
            filtered
              ? { iconName: 'search', title: 'Keine Treffer', text: 'Zu diesen Filtern gibt es keine Geräte.', action: html`<a class="btn" href="/inventar">Filter zurücksetzen</a>` }
              : {
                  iconName: 'package',
                  title: 'Noch keine Geräte erfasst',
                  text: admin ? 'Lege das erste Gerät an oder importiere eine bestehende Liste als CSV-Datei.' : 'Sobald Geräte erfasst sind, erscheinen sie hier.',
                  action: admin ? html`<a class="btn btn--primary" href="/inventar/neu">${icon('plus', { size: 16 })}Gerät hinzufügen</a><a class="btn" href="/daten">CSV importieren</a>` : '',
                },
          )}
    </div>`;
  return page(c, { title: 'Inventar', active: 'assets', content });
}

// --- Create / edit form -----------------------------------------------------
function assetForm(c, { asset = null, values, errors = {}, planInput = {} }, status = 200) {
  const editing = Boolean(asset);
  const types = editing ? [] : listInspectionTypes();
  const section = (title, hint, body) => html`<fieldset class="form-section">
      <legend>${title}</legend>
      ${hint ? html`<p class="form-section__hint">${hint}</p>` : ''}
      <div class="form-grid">${body}</div>
    </fieldset>`;

  const content = html`${pageHeader({
      title: editing ? `${asset.name} bearbeiten` : 'Gerät hinzufügen',
      back: editing ? { href: `/inventar/${asset.id}`, label: asset.name } : { href: '/inventar', label: 'Inventar' },
    })}
    <form method="post" action="${editing ? `/inventar/${asset.id}` : '/inventar'}" class="card form form--page">
      ${csrfField(c)}
      ${errorSummary(errors)}
      ${section('Stammdaten', '', html`
        ${field({ label: 'Bezeichnung', name: 'name', value: values.name, required: true, error: errors.name, className: 'field--wide', attributes: { maxlength: 150, autofocus: !editing } })}
        ${field({ label: 'Inventarnummer', name: 'inventory_number', value: values.inventory_number, required: editing, error: errors.inventory_number, hint: editing ? '' : 'Vorschlag – kann überschrieben werden.', attributes: { maxlength: 40 } })}
        ${select({ label: 'Kategorie', name: 'category_id', value: values.category_id, placeholder: '– keine –', options: options(listCategories()), createName: 'category_new', createValue: values.category_new, createLabel: 'Neue Kategorie' })}
        ${field({ label: 'Hersteller', name: 'manufacturer', value: values.manufacturer, attributes: { maxlength: 100 } })}
        ${field({ label: 'Modell / Typ', name: 'model', value: values.model, attributes: { maxlength: 100 } })}
        ${field({ label: 'Seriennummer', name: 'serial_number', value: values.serial_number, attributes: { maxlength: 100, spellcheck: 'false' } })}
        ${select({ label: 'Status', name: 'status', value: values.status, options: Object.entries(ASSET_STATUS).map(([value, label]) => ({ value, label })) })}
      `)}
      ${section('Standort', '', html`
        ${select({ label: 'Standort', name: 'location_id', value: values.location_id, placeholder: '– keiner –', options: options(listLocations()), createName: 'location_new', createValue: values.location_new, createLabel: 'Neuer Standort' })}
        ${field({ label: 'Raum / Platz', name: 'location_detail', value: values.location_detail, hint: 'z. B. Raum 2.14, Regal B', attributes: { maxlength: 100 } })}
        ${field({ label: 'Verantwortlich / genutzt von', name: 'assigned_to', value: values.assigned_to, attributes: { maxlength: 100 } })}
      `)}
      ${section('Anschaffung', 'Diese Angaben sind nur für Administratoren sichtbar.', html`
        ${field({ label: 'Kaufdatum', name: 'purchase_date', type: 'date', value: values.purchase_date, error: errors.purchase_date })}
        ${field({ label: 'Anschaffungspreis (€)', name: 'purchase_price', value: values.purchase_price, error: errors.purchase_price, attributes: { inputmode: 'decimal', placeholder: '0,00' } })}
        ${field({ label: 'Lieferant / Händler', name: 'supplier', value: values.supplier, attributes: { maxlength: 120 } })}
        ${field({ label: 'Rechnungsnummer', name: 'invoice_number', value: values.invoice_number, attributes: { maxlength: 80 } })}
        ${field({ label: 'Garantie bis', name: 'warranty_until', type: 'date', value: values.warranty_until, error: errors.warranty_until })}
        ${select({ label: 'Eigentumsverhältnis', name: 'ownership', value: values.ownership, options: Object.entries(OWNERSHIP).map(([value, label]) => ({ value, label })) })}
      `)}
      ${section('Versicherung', '', html`
        ${select({ label: 'Versicherung', name: 'policy_id', value: values.policy_id, placeholder: '– nicht zugeordnet –', options: options(listPolicies()), hint: 'Policen werden unter „Stammdaten“ gepflegt.' })}
        ${field({ label: 'Versicherungswert (€)', name: 'insured_value', value: values.insured_value, error: errors.insured_value, hint: 'Neu- bzw. Wiederbeschaffungswert. Leer = Anschaffungspreis.', attributes: { inputmode: 'decimal', placeholder: '0,00' } })}
      `)}
      ${types.length > 0
        ? html`<fieldset class="form-section">
            <legend>Prüfpflichten</legend>
            <p class="form-section__hint">Welche wiederkehrenden Prüfungen braucht dieses Gerät? Lässt sich später jederzeit ändern.</p>
            <div class="plan-picker">
              ${types.map(
                (type) => html`<div class="plan-picker__row">
                  ${checkbox({ label: type.name, name: `plan_${type.id}`, checked: Boolean(planInput[`plan_${type.id}`]) })}
                  ${field({ label: 'Intervall (Monate)', name: `plan_interval_${type.id}`, type: 'number', value: planInput[`plan_interval_${type.id}`] ?? type.default_interval_months, attributes: { min: 1, max: 240 } })}
                  ${field({ label: 'Nächste Fälligkeit', name: `plan_due_${type.id}`, type: 'date', value: planInput[`plan_due_${type.id}`] ?? '' })}
                </div>`,
              )}
            </div>
          </fieldset>`
        : ''}
      ${section('Notizen', '', textarea({ label: 'Notizen', name: 'notes', value: values.notes, rows: 4, className: 'field--wide', attributes: { maxlength: 5000 } }))}
      <div class="form-actions form-actions--sticky">
        <a class="btn" href="${editing ? `/inventar/${asset.id}` : '/inventar'}">Abbrechen</a>
        <button type="submit" class="btn btn--primary">${icon('check', { size: 16 })}${editing ? 'Änderungen speichern' : 'Gerät anlegen'}</button>
      </div>
    </form>`;
  return page(c, { title: editing ? 'Gerät bearbeiten' : 'Gerät hinzufügen', active: 'assets', narrow: true, content }, status);
}

/** Database row → values as the form fields expect them. */
function formValues(asset) {
  return {
    ...asset,
    purchase_price: formatAmount(asset.purchase_price_cents),
    insured_value: formatAmount(asset.insured_value_cents),
  };
}

/** Resolves a select that may also carry "create new" into an existing id (or null). */
function reference(form, name, createName, table, ensure) {
  const value = form.text(name);
  if (value === '__new' && ensure) return ensure(form.text(createName));
  if (!/^\d+$/.test(value)) return null;
  return get(`SELECT id FROM ${table} WHERE id = ?`, Number(value))?.id ?? null;
}

async function readAsset(c, id = null) {
  const form = await readForm(c);
  const input = form.values();
  const { values, errors } = validateAsset(input, { id });
  return { form, input, values, errors };
}

function references(form) {
  return {
    category_id: reference(form, 'category_id', 'category_new', 'categories', ensureCategory),
    location_id: reference(form, 'location_id', 'location_new', 'locations', ensureLocation),
    policy_id: reference(form, 'policy_id', null, 'policies', null),
  };
}

export const assetRoutes = new Hono();

assetRoutes.get('/inventar', (c) => assetList(c));

assetRoutes.get('/inventar/neu', requireAdmin, (c) => {
  const template = /^\d+$/.test(c.req.query('kopie') ?? '') ? getAsset(Number(c.req.query('kopie'))) : null;
  const values = template
    ? { ...formValues(template), inventory_number: nextInventoryNumber(), serial_number: '' }
    : { inventory_number: nextInventoryNumber(), status: 'active', ownership: 'owned' };
  return assetForm(c, { values });
});

assetRoutes.post('/inventar', requireAdmin, async (c) => {
  const { form, input, values, errors } = await readAsset(c);
  // Selected inspection plans: validate before anything is written.
  const plans = [];
  for (const type of listInspectionTypes()) {
    if (!form.has(`plan_${type.id}`)) continue;
    const intervalMonths = parseInterval(input[`plan_interval_${type.id}`]) ?? type.default_interval_months;
    const nextDue = parseDate(input[`plan_due_${type.id}`]);
    if (nextDue === undefined) errors[`plan_due_${type.id}`] = `Das Fälligkeitsdatum für „${type.name}“ ist ungültig.`;
    plans.push({ typeId: type.id, intervalMonths, nextDue: nextDue ?? null });
  }
  if (Object.keys(errors).length > 0) return assetForm(c, { values: input, errors, planInput: input }, 422);

  const asset = createAsset({ ...values, ...references(form) }, c.get('user'));
  for (const plan of plans) savePlan(asset, plan.typeId, plan, c.get('user'));
  return redirect(c, `/inventar/${asset.id}`, `${asset.inventory_number} wurde angelegt.`);
});

assetRoutes.get('/inventar/:id{[0-9]+}', (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound('Dieses Gerät gibt es nicht (mehr).');
  const user = c.get('user');
  const content = assetDetail(c, asset, {
    plans: listAssetPlans(asset.id),
    inspections: listAssetInspections(asset.id),
    defects: listAssetDefects(asset.id),
    attachments: listAttachments(asset.id, user),
    events: listAssetEvents(asset.id),
    types: listInspectionTypes(),
    cover: coverPhoto(asset.id),
  });
  return page(c, { title: asset.name, active: 'assets', content });
});

assetRoutes.get('/inventar/:id{[0-9]+}/bearbeiten', requireAdmin, (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  return assetForm(c, { asset, values: formValues(asset) });
});

assetRoutes.post('/inventar/:id{[0-9]+}', requireAdmin, async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const { form, input, values, errors } = await readAsset(c, asset.id);
  if (Object.keys(errors).length > 0) return assetForm(c, { asset, values: input, errors }, 422);
  updateAsset(asset.id, { ...values, ...references(form) }, c.get('user'));
  return redirect(c, `/inventar/${asset.id}`, 'Änderungen gespeichert.');
});

assetRoutes.post('/inventar/:id{[0-9]+}/loeschen', requireAdmin, async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const pending = await confirmation(c, {
    title: 'Gerät löschen',
    message: `„${asset.name}“ (${asset.inventory_number}) endgültig löschen? Alle Defekte, Prüfungen und Dateien dieses Geräts gehen verloren.`,
    cancel: `/inventar/${asset.id}`,
  });
  if (pending) return pending;
  deleteAsset(asset.id, c.get('user'));
  return redirect(c, '/inventar', `${asset.inventory_number} wurde gelöscht.`);
});

assetRoutes.get('/inventar/:id{[0-9]+}/qr.svg', (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  return c.body(qrSvg(`${publicOrigin(c)}/q/${asset.code}`, { margin: 4, title: asset.inventory_number }), 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Disposition': `inline; filename="${asset.inventory_number.replace(/[^\w.-]/g, '_')}.svg"`,
  });
});

// --- Files --------------------------------------------------------------------
assetRoutes.post('/inventar/:id{[0-9]+}/anhaenge', requireAdmin, async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const form = await readForm(c);
  const kind = form.text('kind') in ATTACHMENT_KIND ? form.text('kind') : 'photo';
  const files = form.files('files');
  if (files.length === 0) return redirect(c, `/inventar/${asset.id}#dateien`, 'Bitte zuerst eine Datei auswählen.', 'error');
  const { saved, errors } = await addAttachments(files, { asset, user: c.get('user'), kind });
  if (errors.length > 0) return redirect(c, `/inventar/${asset.id}#dateien`, errors.join(' '), 'error');
  return redirect(c, `/inventar/${asset.id}#dateien`, `${plural(saved, 'Datei', 'Dateien')} hochgeladen.`);
});

assetRoutes.post('/anhaenge/:id{[0-9]+}/loeschen', requireAdmin, async (c) => {
  const attachment = getAttachment(idParam(c));
  if (!attachment) throw notFound();
  const asset = getAsset(attachment.asset_id);
  const pending = await confirmation(c, { title: 'Datei löschen', message: `„${attachment.filename}“ wirklich löschen?`, cancel: `/inventar/${asset.id}` });
  if (pending) return pending;
  deleteAttachment(attachment, asset, c.get('user'));
  return redirect(c, `/inventar/${asset.id}#dateien`, 'Datei gelöscht.');
});

// --- Inspection plans ---------------------------------------------------------
assetRoutes.post('/inventar/:id{[0-9]+}/pruefplaene', requireAdmin, async (c) => {
  const asset = getAsset(idParam(c));
  if (!asset) throw notFound();
  const input = (await readForm(c)).values();
  const type = /^\d+$/.test(input.type_id ?? '') ? getInspectionType(Number(input.type_id)) : null;
  const target = `/inventar/${asset.id}#pruefungen`;
  if (!type) return redirect(c, target, 'Bitte eine Prüfart wählen.', 'error');
  const plan = validatePlan({ ...input, interval_months: input.interval_months || type.default_interval_months });
  if (plan.error) return redirect(c, target, plan.error, 'error');
  savePlan(asset, type.id, plan, c.get('user'));
  return redirect(c, target, `Prüfplan „${type.name}“ gespeichert.`);
});

assetRoutes.post('/pruefplaene/:id{[0-9]+}/loeschen', requireAdmin, async (c) => {
  const plan = getPlan(idParam(c));
  if (!plan) throw notFound();
  const asset = getAsset(plan.asset_id);
  const pending = await confirmation(c, {
    title: 'Prüfplan entfernen',
    message: `Prüfplan „${plan.type_name}“ entfernen? Bereits eingetragene Prüfungen bleiben erhalten.`,
    label: 'Entfernen',
    cancel: `/inventar/${asset.id}`,
  });
  if (pending) return pending;
  removePlan(plan, asset, c.get('user'));
  return redirect(c, `/inventar/${asset.id}#pruefungen`, 'Prüfplan entfernt.');
});
