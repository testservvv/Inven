// Daily snapshot of the database inside DATA_DIR/backups.
//
// This protects against accidental deletions and a damaged database file. It
// does not replace copying the whole data directory to another machine.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { db } from '../db.js';
import { today } from '../lib/format.js';

const PATTERN = /^inventar-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** Writes today's snapshot if it does not exist yet and removes outdated ones. */
export async function snapshot({ force = false } = {}) {
  const target = path.join(paths.backups, `inventar-${today()}.sqlite`);
  if (force || !fs.existsSync(target)) {
    // better-sqlite3's online backup yields a consistent copy while the app keeps running.
    await db.backup(`${target}.tmp`);
    fs.renameSync(`${target}.tmp`, target);
  }
  const snapshots = fs.readdirSync(paths.backups).filter((name) => PATTERN.test(name)).sort();
  for (const name of snapshots.slice(0, Math.max(0, snapshots.length - config.backupKeep))) {
    fs.rmSync(path.join(paths.backups, name), { force: true });
  }
  return target;
}

export function scheduleSnapshots() {
  if (config.backupKeep <= 0) return;
  const run = () => snapshot().catch((error) => console.error('Datensicherung fehlgeschlagen:', error.message));
  run();
  setInterval(run, 6 * 3600_000).unref();
}
