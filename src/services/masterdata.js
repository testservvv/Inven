// Master data: categories, locations, insurance policies and inspection types.
import { all, get, run } from '../db.js';
import { cleanText, parseDate, parseMoney } from '../lib/format.js';

const DUPLICATE = 'Diesen Namen gibt es bereits.';

/** Runs an insert/update and translates a UNIQUE violation into a form error. */
function guarded(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return DUPLICATE;
    throw error;
  }
}

function findOrCreate(table, name) {
  const clean = cleanText(name, 80);
  if (!clean) return null;
  const existing = get(`SELECT id FROM ${table} WHERE name = ?`, clean);
  return existing ? existing.id : Number(run(`INSERT INTO ${table} (name) VALUES (?)`, clean).lastInsertRowid);
}

// --- Categories -------------------------------------------------------------
export const listCategories = () =>
  all(`SELECT c.*, (SELECT COUNT(*) FROM assets a WHERE a.category_id = c.id) AS asset_count
       FROM categories c ORDER BY c.name COLLATE NOCASE`);

export const ensureCategory = (name) => findOrCreate('categories', name);

export function saveCategory(id, input) {
  const name = cleanText(input.name, 80);
  if (!name) return 'Bitte einen Namen angeben.';
  return guarded(() =>
    id ? run('UPDATE categories SET name = ? WHERE id = ?', name, id) : run('INSERT INTO categories (name) VALUES (?)', name),
  );
}

export const deleteCategory = (id) => run('DELETE FROM categories WHERE id = ?', id);

// --- Locations --------------------------------------------------------------
export const listLocations = () =>
  all(`SELECT l.*, (SELECT COUNT(*) FROM assets a WHERE a.location_id = l.id) AS asset_count
       FROM locations l ORDER BY l.name COLLATE NOCASE`);

export const ensureLocation = (name) => findOrCreate('locations', name);

export function saveLocation(id, input) {
  const name = cleanText(input.name, 80);
  const note = cleanText(input.note, 200) || null;
  if (!name) return 'Bitte einen Namen angeben.';
  return guarded(() =>
    id
      ? run('UPDATE locations SET name = ?, note = ? WHERE id = ?', name, note, id)
      : run('INSERT INTO locations (name, note) VALUES (?, ?)', name, note),
  );
}

export const deleteLocation = (id) => run('DELETE FROM locations WHERE id = ?', id);

// --- Insurance policies -----------------------------------------------------
const IN_STOCK = "a.status NOT IN ('retired', 'lost')";

/** Policies with the number and total value of the devices assigned to them. */
export const listPolicies = () =>
  all(`SELECT p.*,
         (SELECT COUNT(*) FROM assets a WHERE a.policy_id = p.id AND ${IN_STOCK}) AS asset_count,
         (SELECT COALESCE(SUM(COALESCE(a.insured_value_cents, a.purchase_price_cents, 0)), 0)
            FROM assets a WHERE a.policy_id = p.id AND ${IN_STOCK}) AS covered_cents
       FROM policies p ORDER BY p.name COLLATE NOCASE`);

export const getPolicy = (id) => get('SELECT * FROM policies WHERE id = ?', id);

export const ensurePolicy = (name) => findOrCreate('policies', name);

export function savePolicy(id, input) {
  const values = {
    name: cleanText(input.name, 80),
    insurer: cleanText(input.insurer, 100) || null,
    policy_number: cleanText(input.policy_number, 80) || null,
    sum_insured_cents: parseMoney(input.sum_insured),
    valid_until: parseDate(input.valid_until),
    contact: cleanText(input.contact, 200) || null,
    note: cleanText(input.note, 500) || null,
  };
  if (!values.name) return 'Bitte eine Bezeichnung angeben.';
  if (values.sum_insured_cents === undefined) return 'Die Versicherungssumme ist kein gültiger Betrag.';
  if (values.valid_until === undefined) return 'Das Ablaufdatum ist ungültig.';
  return guarded(() =>
    id
      ? run(
          `UPDATE policies SET name = @name, insurer = @insurer, policy_number = @policy_number,
             sum_insured_cents = @sum_insured_cents, valid_until = @valid_until, contact = @contact, note = @note
           WHERE id = @id`,
          { ...values, id },
        )
      : run(
          `INSERT INTO policies (name, insurer, policy_number, sum_insured_cents, valid_until, contact, note)
           VALUES (@name, @insurer, @policy_number, @sum_insured_cents, @valid_until, @contact, @note)`,
          values,
        ),
  );
}

export const deletePolicy = (id) => run('DELETE FROM policies WHERE id = ?', id);

// --- Inspection types -------------------------------------------------------
export const listInspectionTypes = () =>
  all(`SELECT t.*,
         (SELECT COUNT(*) FROM inspection_plans p WHERE p.type_id = t.id) AS plan_count,
         (SELECT COUNT(*) FROM inspections i WHERE i.type_id = t.id) AS inspection_count
       FROM inspection_types t ORDER BY t.name COLLATE NOCASE`);

export const getInspectionType = (id) => get('SELECT * FROM inspection_types WHERE id = ?', id);

export function parseInterval(raw) {
  const months = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isInteger(months) && months >= 1 && months <= 240 ? months : null;
}

export function saveInspectionType(id, input) {
  const name = cleanText(input.name, 80);
  const interval = parseInterval(input.default_interval_months);
  const description = cleanText(input.description, 300) || null;
  if (!name) return 'Bitte einen Namen angeben.';
  if (!interval) return 'Das Intervall muss zwischen 1 und 240 Monaten liegen.';
  return guarded(() =>
    id
      ? run('UPDATE inspection_types SET name = ?, default_interval_months = ?, description = ? WHERE id = ?', name, interval, description, id)
      : run('INSERT INTO inspection_types (name, default_interval_months, description) VALUES (?, ?, ?)', name, interval, description),
  );
}

/** Types that are in use keep their history and therefore cannot be removed. */
export function deleteInspectionType(id) {
  const usage = get(
    `SELECT (SELECT COUNT(*) FROM inspection_plans WHERE type_id = @id) AS plans,
            (SELECT COUNT(*) FROM inspections WHERE type_id = @id) AS inspections`,
    { id },
  );
  if (usage.plans > 0 || usage.inspections > 0) {
    return 'Diese Prüfart wird noch von Geräten verwendet und kann deshalb nicht gelöscht werden.';
  }
  run('DELETE FROM inspection_types WHERE id = ?', id);
  return null;
}
