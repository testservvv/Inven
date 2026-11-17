// Defect reports for devices.
import { all, get, now, run } from '../db.js';
import { cleanText, parseMoney } from '../lib/format.js';
import { DEFECT_STATUS, SEVERITY } from '../lib/terms.js';
import { logEvent } from './events.js';

const SELECT = `
  SELECT d.*, a.name AS asset_name, a.inventory_number, a.code AS asset_code, l.name AS location_name
  FROM defects d
  JOIN assets a ON a.id = d.asset_id
  LEFT JOIN locations l ON l.id = a.location_id`;

// Unresolved first, then by severity, newest first.
const ORDER = `ORDER BY (d.status = 'resolved'),
  CASE d.severity WHEN 'critical' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, d.reported_at DESC`;

export const getDefect = (id) => get(`${SELECT} WHERE d.id = ?`, id);

export const listAssetDefects = (assetId) => all(`${SELECT} WHERE d.asset_id = ? ${ORDER}`, assetId);

/** Validates the report form. Returns { values, errors }. */
export function validateDefect(input) {
  const errors = {};
  const values = {
    title: cleanText(input.title, 150),
    description: cleanText(input.description, 3000) || null,
    severity: input.severity in SEVERITY ? input.severity : null,
  };
  if (!values.title) errors.title = 'Bitte kurz beschreiben, was defekt ist.';
  if (!values.severity) errors.severity = 'Bitte einen Schweregrad wählen.';
  return { values, errors };
}

export function createDefect(asset, values, user) {
  const timestamp = now();
  const result = run(
    `INSERT INTO defects (asset_id, title, description, severity, reported_by, reported_by_name, reported_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    asset.id,
    values.title,
    values.description,
    values.severity,
    user.id,
    user.name,
    timestamp,
    timestamp,
  );
  logEvent({ user, asset, action: 'defect.reported', detail: `${values.title} (${SEVERITY[values.severity]})` });
  return Number(result.lastInsertRowid);
}

/**
 * Applies a status change. Admins may also correct title, description,
 * severity and enter repair costs. Returns a map of field errors.
 */
export function updateDefect(defect, input, user) {
  const admin = user.role === 'admin';
  const errors = {};
  const status = input.status in DEFECT_STATUS ? input.status : defect.status;
  const resolution = cleanText(input.resolution, 3000) || null;

  let { title, description, severity, repair_cost_cents: repairCost } = defect;
  if (admin) {
    title = cleanText(input.title ?? defect.title, 150);
    description = input.description === undefined ? defect.description : cleanText(input.description, 3000) || null;
    if (input.severity in SEVERITY) severity = input.severity;
    if (input.repair_cost !== undefined) repairCost = parseMoney(input.repair_cost);
    if (!title) errors.title = 'Bitte einen Titel angeben.';
    if (repairCost === undefined) errors.repair_cost = 'Die Reparaturkosten sind kein gültiger Betrag.';
  }
  if (Object.keys(errors).length > 0) return errors;

  const resolving = status === 'resolved' && defect.status !== 'resolved';
  const reopening = status !== 'resolved' && defect.status === 'resolved';
  const timestamp = now();
  run(
    `UPDATE defects SET title = @title, description = @description, severity = @severity, status = @status,
       resolution = @resolution, repair_cost_cents = @repairCost, updated_at = @timestamp,
       resolved_by = @resolvedBy, resolved_by_name = @resolvedByName, resolved_at = @resolvedAt
     WHERE id = @id`,
    {
      id: defect.id,
      title,
      description,
      severity,
      status,
      resolution,
      repairCost,
      timestamp,
      resolvedBy: resolving ? user.id : reopening ? null : defect.resolved_by,
      resolvedByName: resolving ? user.name : reopening ? null : defect.resolved_by_name,
      resolvedAt: resolving ? timestamp : reopening ? null : defect.resolved_at,
    },
  );

  const asset = { id: defect.asset_id, inventory_number: defect.inventory_number, name: defect.asset_name };
  const action = resolving ? 'defect.resolved' : reopening ? 'defect.reopened' : 'defect.updated';
  const detail = status === defect.status ? title : `${title}: ${DEFECT_STATUS[defect.status]} → ${DEFECT_STATUS[status]}`;
  logEvent({ user, asset, action, detail });
  return errors;
}

export function deleteDefect(defect, user) {
  run('DELETE FROM defects WHERE id = ?', defect.id);
  const asset = { id: defect.asset_id, inventory_number: defect.inventory_number, name: defect.asset_name };
  logEvent({ user, asset, action: 'defect.deleted', detail: defect.title });
}

const likePattern = (word) => `%${word.replace(/[\\%_]/g, '\\$&')}%`;

/** filters: status ('open' = unresolved | 'resolved' | 'all'), severity, q */
export function listDefects(filters = {}, { page = 1, pageSize = 50 } = {}) {
  const params = {};
  const where = [];
  cleanText(filters.q, 100).split(/\s+/).filter(Boolean).slice(0, 6).forEach((word, i) => {
    params[`q${i}`] = likePattern(word);
    where.push(
      `(${['d.title', 'd.description', 'a.name', 'a.inventory_number', 'd.reported_by_name']
        .map((column) => `${column} LIKE @q${i} ESCAPE '\\'`)
        .join(' OR ')})`,
    );
  });
  if (filters.status === 'resolved') where.push("d.status = 'resolved'");
  else if (filters.status !== 'all') where.push("d.status != 'resolved'");
  if (filters.severity in SEVERITY) {
    params.severity = filters.severity;
    where.push('d.severity = @severity');
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM defects d JOIN assets a ON a.id = d.asset_id ${filter}`, params).n;
  const paging = pageSize > 0 ? `LIMIT ${Number(pageSize)} OFFSET ${Math.max(0, (page - 1) * pageSize)}` : '';
  return { rows: all(`${SELECT} ${filter} ${ORDER} ${paging}`, params), total };
}

export function defectCounts() {
  return get(
    `SELECT COALESCE(SUM(status != 'resolved'), 0) AS open,
       COALESCE(SUM(status != 'resolved' AND severity = 'critical'), 0) AS critical,
       COALESCE(SUM(status = 'in_progress'), 0) AS in_progress,
       COALESCE(SUM(status = 'resolved'), 0) AS resolved
     FROM defects`,
  );
}
