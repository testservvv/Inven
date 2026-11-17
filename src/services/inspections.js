// Recurring inspections (Kalibrierung, DGUV V3, Wartung …).
//
// A *plan* says that a device needs a certain type of inspection every N
// months and when it is due next. Every performed inspection is stored as its
// own record; the plan is refreshed from the most recent record.
import { all, get, now, run, tx } from '../db.js';
import { addDays, addMonths, cleanText, formatDate, parseDate, today } from '../lib/format.js';
import { RESULT } from '../lib/terms.js';
import { warnDays } from './settings.js';
import { logEvent } from './events.js';
import { getInspectionType, parseInterval } from './masterdata.js';

const RANK_SQL = `CASE
    WHEN p.last_result = 'failed' THEN 5
    WHEN p.next_due IS NULL THEN 3
    WHEN p.next_due < @today THEN 4
    WHEN p.next_due <= @warn THEN 2
    ELSE 1 END`;
const STATES = [null, 'ok', 'soon', 'open', 'overdue', 'failed'];
const IN_STOCK = "a.status NOT IN ('retired', 'lost')";

function dateParams() {
  const day = today();
  return { today: day, warn: addDays(day, warnDays()) };
}

const withState = (plan) => ({ ...plan, state: STATES[plan.rank] });

export function listAssetPlans(assetId) {
  return all(
    `SELECT p.*, t.name AS type_name, ${RANK_SQL} AS rank
     FROM inspection_plans p JOIN inspection_types t ON t.id = p.type_id
     WHERE p.asset_id = @assetId ORDER BY t.name COLLATE NOCASE`,
    { ...dateParams(), assetId },
  ).map(withState);
}

export const getPlan = (id) =>
  get(
    `SELECT p.*, t.name AS type_name FROM inspection_plans p
     JOIN inspection_types t ON t.id = p.type_id WHERE p.id = ?`,
    id,
  );

/** Creates or updates the plan of one inspection type for a device. */
export function savePlan(asset, typeId, { intervalMonths, nextDue }, user) {
  const type = getInspectionType(typeId);
  if (!type) return 'Unbekannte Prüfart.';
  run(
    `INSERT INTO inspection_plans (asset_id, type_id, interval_months, next_due) VALUES (?, ?, ?, ?)
     ON CONFLICT(asset_id, type_id) DO UPDATE SET interval_months = excluded.interval_months, next_due = excluded.next_due`,
    asset.id,
    typeId,
    intervalMonths,
    nextDue,
  );
  logEvent({
    user,
    asset,
    action: 'plan.saved',
    detail: `${type.name}: alle ${intervalMonths} Monate, nächste Fälligkeit ${nextDue ? formatDate(nextDue) : 'offen'}`,
  });
  return null;
}

/** Reads interval and due date of a plan from form fields. */
export function validatePlan(input) {
  const intervalMonths = parseInterval(input.interval_months);
  const nextDue = parseDate(input.next_due);
  if (!intervalMonths) return { error: 'Das Intervall muss zwischen 1 und 240 Monaten liegen.' };
  if (nextDue === undefined) return { error: 'Das Fälligkeitsdatum ist ungültig.' };
  return { intervalMonths, nextDue };
}

export function removePlan(plan, asset, user) {
  run('DELETE FROM inspection_plans WHERE id = ?', plan.id);
  logEvent({ user, asset, action: 'plan.removed', detail: plan.type_name });
}

/** Brings a plan in line with the latest recorded inspection of its type. */
function refreshPlan(assetId, typeId) {
  const latest = get(
    'SELECT * FROM inspections WHERE asset_id = ? AND type_id = ? ORDER BY performed_on DESC, id DESC LIMIT 1',
    assetId,
    typeId,
  );
  const plan = get('SELECT * FROM inspection_plans WHERE asset_id = ? AND type_id = ?', assetId, typeId);
  if (!latest) {
    // The last record was deleted: the due date it produced no longer holds.
    if (plan) run('UPDATE inspection_plans SET last_performed_on = NULL, last_result = NULL, next_due = NULL WHERE id = ?', plan.id);
    return;
  }
  if (plan) {
    run(
      'UPDATE inspection_plans SET last_performed_on = ?, last_result = ?, next_due = ? WHERE id = ?',
      latest.performed_on,
      latest.result,
      latest.next_due,
      plan.id,
    );
  } else {
    run(
      `INSERT INTO inspection_plans (asset_id, type_id, interval_months, next_due, last_performed_on, last_result)
       VALUES (?, ?, ?, ?, ?, ?)`,
      assetId,
      typeId,
      getInspectionType(typeId).default_interval_months,
      latest.next_due,
      latest.performed_on,
      latest.result,
    );
  }
}

/** Interval that applies to a device: its own plan, otherwise the type's default. */
export function intervalFor(assetId, typeId) {
  const plan = get('SELECT interval_months FROM inspection_plans WHERE asset_id = ? AND type_id = ?', assetId, typeId);
  return plan?.interval_months ?? getInspectionType(typeId)?.default_interval_months ?? 12;
}

/** Validates the "Prüfung eintragen" form. Returns { values, errors }. */
export function validateInspection(input, assetId) {
  const errors = {};
  const typeId = Number.parseInt(input.type_id, 10);
  const type = Number.isInteger(typeId) ? getInspectionType(typeId) : null;
  if (!type) errors.type_id = 'Bitte eine Prüfart wählen.';

  let performedOn = parseDate(input.performed_on);
  if (!performedOn) {
    errors.performed_on = 'Bitte ein gültiges Prüfdatum angeben.';
    performedOn = null;
  } else if (performedOn > today()) {
    errors.performed_on = 'Das Prüfdatum darf nicht in der Zukunft liegen.';
  }

  const result = input.result in RESULT ? input.result : null;
  if (!result) errors.result = 'Bitte ein Ergebnis wählen.';

  let nextDue = parseDate(input.next_due);
  if (nextDue === undefined) {
    errors.next_due = 'Das Fälligkeitsdatum ist ungültig.';
    nextDue = null;
  } else if (nextDue && performedOn && nextDue < performedOn) {
    errors.next_due = 'Die nächste Fälligkeit darf nicht vor dem Prüfdatum liegen.';
  } else if (!nextDue && performedOn && type) {
    nextDue = addMonths(performedOn, intervalFor(assetId, type.id));
  }

  return {
    errors,
    values: {
      type_id: type?.id ?? null,
      type_name: type?.name ?? '',
      performed_on: performedOn,
      result,
      inspector: cleanText(input.inspector, 100) || null,
      certificate_number: cleanText(input.certificate_number, 80) || null,
      notes: cleanText(input.notes, 2000) || null,
      next_due: nextDue,
    },
  };
}

/** Stores an inspection and updates the device's plan. Returns the new record id. */
export function recordInspection(asset, values, user) {
  return tx(() => {
    const result = run(
      `INSERT INTO inspections (asset_id, type_id, performed_on, result, inspector, certificate_number, notes,
         next_due, created_by, created_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asset.id,
      values.type_id,
      values.performed_on,
      values.result,
      values.inspector,
      values.certificate_number,
      values.notes,
      values.next_due,
      user.id,
      user.name,
      now(),
    );
    refreshPlan(asset.id, values.type_id);
    logEvent({
      user,
      asset,
      action: 'inspection.recorded',
      detail: `${values.type_name} am ${formatDate(values.performed_on)}: ${RESULT[values.result]}, nächste Fälligkeit ${formatDate(values.next_due)}`,
    });
    return Number(result.lastInsertRowid);
  });
}

export const getInspection = (id) =>
  get(
    `SELECT i.*, t.name AS type_name FROM inspections i
     JOIN inspection_types t ON t.id = i.type_id WHERE i.id = ?`,
    id,
  );

export function deleteInspection(inspection, asset, user) {
  tx(() => {
    run('DELETE FROM inspections WHERE id = ?', inspection.id);
    refreshPlan(inspection.asset_id, inspection.type_id);
    logEvent({
      user,
      asset,
      action: 'inspection.deleted',
      detail: `${inspection.type_name} vom ${formatDate(inspection.performed_on)}`,
    });
  });
}

export function listAssetInspections(assetId) {
  return all(
    `SELECT i.*, t.name AS type_name FROM inspections i
     JOIN inspection_types t ON t.id = i.type_id
     WHERE i.asset_id = ? ORDER BY i.performed_on DESC, i.id DESC`,
    assetId,
  );
}

/** Most recent inspector per type for a device – used to prefill the form. */
export function lastInspector(assetId, typeId) {
  return (
    get(
      `SELECT inspector FROM inspections WHERE asset_id = ? AND type_id = ? AND inspector IS NOT NULL
       ORDER BY performed_on DESC, id DESC LIMIT 1`,
      assetId,
      typeId,
    )?.inspector ?? ''
  );
}

const likePattern = (word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`;

function searchClause(q, params, columns) {
  const clauses = [];
  cleanText(q, 100).split(/\s+/).filter(Boolean).slice(0, 6).forEach((word, i) => {
    params[`q${i}`] = likePattern(word);
    clauses.push(`(${columns.map((column) => `${column} LIKE @q${i} ESCAPE '\\'`).join(' OR ')})`);
  });
  return clauses;
}

const STATE_FILTER = {
  action: 'rank >= 2',
  overdue: 'rank >= 4',
  soon: 'rank IN (2, 3)',
  ok: 'rank = 1',
};

/**
 * Inspection status of all devices in stock, most urgent first.
 * filters: state ('action' | 'overdue' | 'soon' | 'ok'), type (id), q
 */
export function listPlans(filters = {}, { page = 1, pageSize = 50 } = {}) {
  const params = dateParams();
  const where = searchClause(filters.q, params, ['asset_name', 'inventory_number', 'type_name', 'location_name']);
  if (STATE_FILTER[filters.state]) where.push(STATE_FILTER[filters.state]);
  if (/^\d+$/.test(filters.type ?? '')) {
    params.type = Number(filters.type);
    where.push('type_id = @type');
  }
  const cte = `WITH base AS (
    SELECT p.*, t.name AS type_name, a.name AS asset_name, a.inventory_number, a.code AS asset_code,
           l.name AS location_name, ${RANK_SQL} AS rank
    FROM inspection_plans p
    JOIN inspection_types t ON t.id = p.type_id
    JOIN assets a ON a.id = p.asset_id
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE ${IN_STOCK})`;
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`${cte} SELECT COUNT(*) AS n FROM base ${filter}`, params).n;
  const paging = pageSize > 0 ? `LIMIT ${Number(pageSize)} OFFSET ${Math.max(0, (page - 1) * pageSize)}` : '';
  const rows = all(
    `${cte} SELECT * FROM base ${filter}
     ORDER BY rank DESC, (next_due IS NULL), next_due, inventory_number COLLATE NOCASE ${paging}`,
    params,
  ).map(withState);
  return { rows, total };
}

/** Number of plans per state for devices in stock. */
export function planCounts() {
  const counts = { failed: 0, overdue: 0, open: 0, soon: 0, ok: 0, total: 0 };
  const rows = all(
    `SELECT ${RANK_SQL} AS rank, COUNT(*) AS n FROM inspection_plans p
     JOIN assets a ON a.id = p.asset_id WHERE ${IN_STOCK} GROUP BY rank`,
    dateParams(),
  );
  for (const row of rows) {
    counts[STATES[row.rank]] = row.n;
    counts.total += row.n;
  }
  return { ...counts, action: counts.failed + counts.overdue + counts.open + counts.soon };
}

/** Log of performed inspections across all devices. filters: type, q */
export function listInspections(filters = {}, { page = 1, pageSize = 50 } = {}) {
  const params = {};
  const where = searchClause(filters.q, params, ['a.name', 'a.inventory_number', 't.name', 'i.inspector', 'i.certificate_number']);
  if (/^\d+$/.test(filters.type ?? '')) {
    params.type = Number(filters.type);
    where.push('i.type_id = @type');
  }
  const from = `FROM inspections i
    JOIN inspection_types t ON t.id = i.type_id
    JOIN assets a ON a.id = i.asset_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = get(`SELECT COUNT(*) AS n ${from}`, params).n;
  const paging = pageSize > 0 ? `LIMIT ${Number(pageSize)} OFFSET ${Math.max(0, (page - 1) * pageSize)}` : '';
  const rows = all(
    `SELECT i.*, t.name AS type_name, a.name AS asset_name, a.inventory_number
     ${from} ORDER BY i.performed_on DESC, i.id DESC ${paging}`,
    params,
  );
  return { rows, total };
}
