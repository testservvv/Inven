// Inventory items ("Geräte").
import { all, get, now, run, tx } from '../db.js';
import { ASSET_STATUS, OWNERSHIP } from '../lib/terms.js';
import { addDays, cleanText, formatDate, formatMoney, parseDate, parseMoney, today } from '../lib/format.js';
import { randomString } from '../lib/security.js';
import { removeUpload } from '../lib/uploads.js';
import { getSetting, warnDays } from './settings.js';
import { logEvent } from './events.js';

/** Devices that count towards stock and insured value. */
export const IN_STOCK = "status NOT IN ('retired', 'lost')";

// Inspection urgency as a number so SQL can aggregate and sort it.
const PLAN_RANK_SQL = `CASE
    WHEN p.last_result = 'failed' THEN 5
    WHEN p.next_due IS NULL THEN 3
    WHEN p.next_due < @today THEN 4
    WHEN p.next_due <= @warn THEN 2
    ELSE 1 END`;
export const PLAN_RANK = [null, 'ok', 'soon', 'open', 'overdue', 'failed'];

const BASE = `
  SELECT a.*,
    c.name AS category_name,
    l.name AS location_name,
    po.name AS policy_name,
    COALESCE(a.insured_value_cents, a.purchase_price_cents) AS value_cents,
    (SELECT COUNT(*) FROM defects d WHERE d.asset_id = a.id AND d.status != 'resolved') AS open_defects,
    (SELECT MAX(CASE d.severity WHEN 'critical' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
       FROM defects d WHERE d.asset_id = a.id AND d.status != 'resolved') AS defect_rank,
    (SELECT MIN(p.next_due) FROM inspection_plans p WHERE p.asset_id = a.id) AS next_due,
    (SELECT MAX(${PLAN_RANK_SQL}) FROM inspection_plans p WHERE p.asset_id = a.id) AS plan_rank
  FROM assets a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN locations l ON l.id = a.location_id
  LEFT JOIN policies po ON po.id = a.policy_id`;

function dateParams() {
  const day = today();
  return { today: day, warn: addDays(day, warnDays()) };
}

export function getAsset(id) {
  return get(`${BASE} WHERE a.id = @id`, { ...dateParams(), id });
}

export function getAssetByCode(code) {
  return get(`${BASE} WHERE a.code = @code`, { ...dateParams(), code: String(code).toUpperCase() });
}

const SORTS = {
  inv: 'inventory_number COLLATE NOCASE',
  name: 'name COLLATE NOCASE',
  category: 'category_name COLLATE NOCASE',
  location: 'location_name COLLATE NOCASE',
  serial: 'serial_number COLLATE NOCASE',
  status: 'status',
  value: 'value_cents',
  due: 'next_due',
  created: 'created_at',
};
export const ASSET_SORTS = Object.keys(SORTS);

const SEARCH_COLUMNS = [
  'name', 'inventory_number', 'serial_number', 'manufacturer', 'model', 'assigned_to',
  'location_detail', 'category_name', 'location_name', 'supplier', 'invoice_number', 'notes',
];

const likePattern = (word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`;

function buildFilter(filters) {
  const where = [];
  const params = dateParams();
  const words = cleanText(filters.q, 100).split(/\s+/).filter(Boolean).slice(0, 6);
  words.forEach((word, i) => {
    params[`q${i}`] = likePattern(word);
    where.push(`(${SEARCH_COLUMNS.map((column) => `${column} LIKE @q${i} ESCAPE '\\'`).join(' OR ')})`);
  });
  for (const [key, column] of [['category', 'category_id'], ['location', 'location_id'], ['policy', 'policy_id']]) {
    if (filters[key] === 'none') where.push(`${column} IS NULL`);
    else if (/^\d+$/.test(filters[key] ?? '')) {
      params[key] = Number(filters[key]);
      where.push(`${column} = @${key}`);
    }
  }
  if (filters.status in ASSET_STATUS) {
    params.status = filters.status;
    where.push('status = @status');
  } else if (filters.status === 'stock') where.push(IN_STOCK);

  if (filters.condition === 'defect') where.push('open_defects > 0');
  else if (filters.condition === 'due') where.push('plan_rank >= 2');
  else if (filters.condition === 'overdue') where.push('plan_rank >= 4');
  else if (filters.condition === 'ok') where.push('open_defects = 0 AND COALESCE(plan_rank, 1) = 1');

  if (Array.isArray(filters.ids)) {
    const ids = filters.ids.map(Number).filter(Number.isInteger).slice(0, 2000);
    where.push(`id IN (${ids.length ? ids.join(',') : 'NULL'})`);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * @param {object} filters  q, category, location, policy, status, condition, ids
 * @param {object} [options] sort, dir, page, pageSize (0 = no paging)
 */
export function listAssets(filters = {}, { sort = 'inv', dir = 'asc', page = 1, pageSize = 50 } = {}) {
  const { where, params } = buildFilter(filters);
  const column = SORTS[sort] ?? SORTS.inv;
  const direction = dir === 'desc' ? 'DESC' : 'ASC';
  // NULLs always go last, whatever the direction.
  const order = `ORDER BY (${column.split(' ')[0]} IS NULL), ${column} ${direction}, id ${direction}`;
  const cte = `WITH base AS (${BASE})`;
  const totals = get(`${cte} SELECT COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS value FROM base ${where}`, params);
  const paging = pageSize > 0 ? `LIMIT ${Number(pageSize)} OFFSET ${Math.max(0, (page - 1) * pageSize)}` : '';
  const rows = all(`${cte} SELECT * FROM base ${where} ${order} ${paging}`, params);
  return { rows, total: totals.n, value: totals.value };
}

/** Suggests the next free number for the configured prefix, e.g. "INV-0042". */
export function nextInventoryNumber() {
  const prefix = getSetting('inventory_prefix');
  let highest = 0;
  for (const row of all("SELECT inventory_number FROM assets WHERE inventory_number LIKE ? ESCAPE '\\'", `${prefix.replace(/[\\%_]/g, '\\$&')}%`)) {
    const tail = row.inventory_number.slice(prefix.length);
    if (/^\d{1,9}$/.test(tail)) highest = Math.max(highest, Number(tail));
  }
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

function newCode() {
  for (;;) {
    const code = randomString(8);
    if (!get('SELECT 1 FROM assets WHERE code = ?', code)) return code;
  }
}

const TEXT_FIELDS = {
  name: 150,
  inventory_number: 40,
  manufacturer: 100,
  model: 100,
  serial_number: 100,
  assigned_to: 100,
  location_detail: 100,
  supplier: 120,
  invoice_number: 80,
  notes: 5000,
};

/**
 * Validates the plain form/CSV fields of a device (everything except the
 * references to category, location and policy, which the caller resolves).
 * Returns { values, errors }.
 */
export function validateAsset(input, { id = null, autoNumber = true } = {}) {
  const errors = {};
  const values = {};
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    values[field] = cleanText(input[field], max) || null;
  }
  if (!values.name) errors.name = 'Bitte eine Bezeichnung angeben.';

  if (!values.inventory_number) {
    // New devices get the next free number; the CSV import assigns it later, row by row.
    if (id) errors.inventory_number = 'Bitte eine Inventarnummer angeben.';
    else if (autoNumber) values.inventory_number = nextInventoryNumber();
  } else {
    const duplicate = get('SELECT id FROM assets WHERE inventory_number = ?', values.inventory_number);
    if (duplicate && duplicate.id !== id) errors.inventory_number = 'Diese Inventarnummer ist bereits vergeben.';
  }

  values.status = input.status in ASSET_STATUS ? input.status : 'active';
  values.ownership = input.ownership in OWNERSHIP ? input.ownership : 'owned';

  for (const [field, label] of [['purchase_date', 'Das Kaufdatum'], ['warranty_until', 'Das Garantiedatum']]) {
    values[field] = parseDate(input[field]);
    if (values[field] === undefined) {
      errors[field] = `${label} ist ungültig (Format: TT.MM.JJJJ).`;
      values[field] = null;
    }
  }
  for (const [field, column, label] of [
    ['purchase_price', 'purchase_price_cents', 'Der Anschaffungspreis'],
    ['insured_value', 'insured_value_cents', 'Der Versicherungswert'],
  ]) {
    values[column] = parseMoney(input[field]);
    if (values[column] === undefined) {
      errors[field] = `${label} ist kein gültiger Betrag (Beispiel: 1.249,00).`;
      values[column] = null;
    }
  }
  return { values, errors };
}

const COLUMNS = [
  'inventory_number', 'name', 'category_id', 'location_id', 'location_detail', 'manufacturer', 'model',
  'serial_number', 'status', 'assigned_to', 'ownership', 'purchase_date', 'purchase_price_cents', 'supplier',
  'invoice_number', 'warranty_until', 'policy_id', 'insured_value_cents', 'notes',
];

export function createAsset(values, user, { action = 'asset.created' } = {}) {
  const timestamp = now();
  const row = { category_id: null, location_id: null, policy_id: null, ...values, code: newCode(), created_by: user?.id ?? null, created_at: timestamp, updated_at: timestamp };
  const result = run(
    `INSERT INTO assets (code, created_by, created_at, updated_at, ${COLUMNS.join(', ')})
     VALUES (@code, @created_by, @created_at, @updated_at, ${COLUMNS.map((column) => `@${column}`).join(', ')})`,
    row,
  );
  const asset = getAsset(result.lastInsertRowid);
  logEvent({ user, asset, action });
  return asset;
}

const CHANGE_LABELS = {
  inventory_number: 'Inventarnummer',
  name: 'Bezeichnung',
  category_name: 'Kategorie',
  location_name: 'Standort',
  location_detail: 'Raum / Platz',
  manufacturer: 'Hersteller',
  model: 'Modell',
  serial_number: 'Seriennummer',
  status: 'Status',
  assigned_to: 'Verantwortlich',
  ownership: 'Eigentumsverhältnis',
  purchase_date: 'Kaufdatum',
  purchase_price_cents: 'Anschaffungspreis',
  supplier: 'Lieferant',
  invoice_number: 'Rechnungsnummer',
  warranty_until: 'Garantie bis',
  policy_name: 'Versicherung',
  insured_value_cents: 'Versicherungswert',
  notes: 'Notizen',
};

function display(field, value) {
  if (value === null || value === undefined || value === '') return '–';
  if (field === 'status') return ASSET_STATUS[value];
  if (field === 'ownership') return OWNERSHIP[value];
  if (field.endsWith('_cents')) return formatMoney(value);
  if (field === 'purchase_date' || field === 'warranty_until') return formatDate(value);
  return String(value);
}

/** "Standort: Lager → Werkstatt; Status: In Betrieb → In Reparatur" */
function describeChanges(before, after) {
  const changes = [];
  for (const [field, label] of Object.entries(CHANGE_LABELS)) {
    if ((before[field] ?? null) === (after[field] ?? null)) continue;
    changes.push(field === 'notes' ? 'Notizen geändert' : `${label}: ${display(field, before[field])} → ${display(field, after[field])}`);
  }
  return changes.join('; ');
}

export function updateAsset(id, values, user) {
  const before = getAsset(id);
  if (!before) return null;
  const row = { ...Object.fromEntries(COLUMNS.map((column) => [column, before[column]])), ...values, id, updated_at: now() };
  run(`UPDATE assets SET updated_at = @updated_at, ${COLUMNS.map((column) => `${column} = @${column}`).join(', ')} WHERE id = @id`, row);
  const after = getAsset(id);
  const detail = describeChanges(before, after);
  if (detail) logEvent({ user, asset: after, action: 'asset.updated', detail });
  return after;
}

/** Deletes a device with all defects, inspections and files. */
export function deleteAsset(id, user) {
  const asset = getAsset(id);
  if (!asset) return false;
  const files = all('SELECT token FROM attachments WHERE asset_id = ?', id);
  tx(() => {
    logEvent({ user, asset, action: 'asset.deleted' });
    run('DELETE FROM assets WHERE id = ?', id);
  });
  for (const file of files) removeUpload(file.token);
  return true;
}

/** Key figures for the dashboard. */
export function assetStats() {
  return get(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN ${IN_STOCK} THEN 1 ELSE 0 END), 0) AS in_stock,
       COALESCE(SUM(CASE WHEN ${IN_STOCK} THEN COALESCE(insured_value_cents, purchase_price_cents, 0) ELSE 0 END), 0) AS value_cents,
       COALESCE(SUM(CASE WHEN ${IN_STOCK} AND policy_id IS NULL THEN 1 ELSE 0 END), 0) AS uninsured,
       COALESCE(SUM(CASE WHEN ${IN_STOCK} AND policy_id IS NULL THEN COALESCE(insured_value_cents, purchase_price_cents, 0) ELSE 0 END), 0) AS uninsured_cents
     FROM assets`,
  );
}

export function recentAssets(limit = 5) {
  return all(`${BASE} ORDER BY a.id DESC LIMIT @limit`, { ...dateParams(), limit });
}
