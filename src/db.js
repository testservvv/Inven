// SQLite access (better-sqlite3, synchronous) plus schema migrations.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config, paths } from './config.js';

for (const dir of [config.dataDir, paths.uploads, paths.backups, paths.tmp]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(paths.database);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Prepared statements are cached by SQL text. List pages build SQL dynamically
// (filters, sorting), so the cache is capped to stay bounded.
const statements = new Map();
function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    if (statements.size < 500) statements.set(sql, statement);
  }
  return statement;
}

export const get = (sql, ...params) => prepare(sql).get(...params);
export const all = (sql, ...params) => prepare(sql).all(...params);
export const run = (sql, ...params) => prepare(sql).run(...params);
/** Runs fn inside a transaction; rolls back when it throws. */
export const tx = (fn) => db.transaction(fn)();

export const now = () => new Date().toISOString();

// --- Schema -----------------------------------------------------------------
// Each entry runs exactly once, in order; PRAGMA user_version tracks progress.
// Never edit a released migration – append a new one instead.
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE recovery_codes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 0,
    flash TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE login_challenges (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persistent INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE login_throttle (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT NOT NULL,
    locked_until TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    note TEXT
  );

  CREATE TABLE policies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    insurer TEXT,
    policy_number TEXT,
    sum_insured_cents INTEGER,
    valid_until TEXT,
    contact TEXT,
    note TEXT
  );

  CREATE TABLE inspection_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    default_interval_months INTEGER NOT NULL DEFAULT 12,
    description TEXT
  );

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    inventory_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    location_detail TEXT,
    manufacturer TEXT,
    model TEXT,
    serial_number TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'storage', 'repair', 'retired', 'lost')),
    assigned_to TEXT,
    ownership TEXT NOT NULL DEFAULT 'owned'
      CHECK (ownership IN ('owned', 'leased', 'rented', 'loaned')),
    purchase_date TEXT,
    purchase_price_cents INTEGER,
    supplier TEXT,
    invoice_number TEXT,
    warranty_until TEXT,
    policy_id INTEGER REFERENCES policies(id) ON DELETE SET NULL,
    insured_value_cents INTEGER,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX assets_category ON assets(category_id);
  CREATE INDEX assets_location ON assets(location_id);
  CREATE INDEX assets_policy ON assets(policy_id);

  CREATE TABLE inspection_plans (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL REFERENCES inspection_types(id) ON DELETE RESTRICT,
    interval_months INTEGER NOT NULL,
    next_due TEXT,
    last_performed_on TEXT,
    last_result TEXT,
    UNIQUE (asset_id, type_id)
  );
  CREATE INDEX inspection_plans_due ON inspection_plans(next_due);

  CREATE TABLE inspections (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    type_id INTEGER NOT NULL REFERENCES inspection_types(id) ON DELETE RESTRICT,
    performed_on TEXT NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('passed', 'remarks', 'failed')),
    inspector TEXT,
    certificate_number TEXT,
    notes TEXT,
    next_due TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX inspections_asset ON inspections(asset_id, type_id, performed_on);

  CREATE TABLE defects (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
    reported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reported_by_name TEXT,
    reported_at TEXT NOT NULL,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_by_name TEXT,
    resolved_at TEXT,
    resolution TEXT,
    repair_cost_cents INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX defects_asset ON defects(asset_id);
  CREATE INDEX defects_status ON defects(status);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    defect_id INTEGER REFERENCES defects(id) ON DELETE SET NULL,
    inspection_id INTEGER REFERENCES inspections(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('photo', 'invoice', 'report', 'document')),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    uploaded_by_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_asset ON attachments(asset_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    asset_label TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_asset ON events(asset_id);
  CREATE INDEX events_created ON events(created_at);
  `,
];

export function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
  if (current === 0) seed();
}

// Starter data for a fresh installation; everything can be edited or removed later.
function seed() {
  db.transaction(() => {
    const type = db.prepare(
      'INSERT INTO inspection_types (name, default_interval_months, description) VALUES (?, ?, ?)',
    );
    type.run('Kalibrierung', 12, 'Kalibrierung von Mess- und Prüfmitteln inkl. Kalibrierschein');
    type.run(
      'Elektroprüfung (DGUV V3)',
      12,
      'Wiederholungsprüfung ortsveränderlicher elektrischer Betriebsmittel',
    );
    type.run('Wartung / Inspektion', 12, 'Regelmäßige Wartung nach Herstellervorgabe');

    const category = db.prepare('INSERT INTO categories (name) VALUES (?)');
    for (const name of ['IT & EDV', 'Messtechnik', 'Werkzeug', 'Maschinen', 'Büroausstattung', 'Sonstiges']) {
      category.run(name);
    }
  })();
}

migrate();
