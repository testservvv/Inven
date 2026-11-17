// Complete backup ("Komplettsicherung") for moving the inventory to another
// server: one .tar.gz with the database, all uploaded files and the key that
// protects the two-factor secrets.
//
// Restoring is only possible on a fresh installation (no accounts yet). That
// rules out overwriting live data by mistake.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { config, paths } from '../config.js';
import { SCHEMA_VERSION, all, db, get, replaceDatabase, run } from '../db.js';
import { TarExtractor, tarStream } from '../lib/tar.js';
import { uploadPath } from '../lib/uploads.js';
import { forgetKey } from '../lib/secretbox.js';
import { formatBytes, today } from '../lib/format.js';
import { companyName, deleteSetting, reloadSettings } from './settings.js';
import { countUsers } from './users.js';

const FORMAT = 'inventar-sicherung';
const FORMAT_VERSION = 1;

export class RestoreError extends Error {}

const randomId = () => crypto.randomBytes(8).toString('hex');

function counts(connection = db) {
  const count = (table) => connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    assets: count('assets'),
    users: count('users'),
    attachments: count('attachments'),
    defects: count('defects'),
    inspections: count('inspections'),
  };
}

/** Approximate size of a backup before compression. */
export function estimateSize() {
  let bytes = get('SELECT COALESCE(SUM(size), 0) AS n FROM attachments').n;
  for (const suffix of ['', '-wal']) {
    try {
      bytes += fs.statSync(`${paths.database}${suffix}`).size;
    } catch {
      // A missing WAL file simply adds nothing.
    }
  }
  return bytes;
}

/**
 * Starts a backup. Returns the gzip stream plus metadata; the stream must be
 * consumed (or destroyed), which also removes the temporary database copy.
 */
export async function createArchive() {
  const workDir = path.join(paths.tmp, `export-${randomId()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const cleanup = () => fs.rmSync(workDir, { recursive: true, force: true });
  try {
    // A consistent copy of the database, taken while the app keeps running.
    const snapshot = path.join(workDir, 'inventar.sqlite');
    await db.backup(snapshot);
    const manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      created_at: new Date().toISOString(),
      schema_version: SCHEMA_VERSION,
      company: companyName(),
      counts: counts(),
    };
    const entries = [
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: 'inventar.sqlite', path: snapshot },
    ];
    if (fs.existsSync(paths.appKey)) entries.push({ name: 'app.key', path: paths.appKey });
    for (const { token } of all('SELECT token FROM attachments ORDER BY id')) {
      entries.push({ name: `uploads/${token.slice(0, 2)}/${token}`, path: uploadPath(token) });
    }
    const gzip = zlib.createGzip({ level: 6 });
    // pipeline() tears everything down if the download is aborted half-way.
    pipeline(Readable.from(tarStream(entries), { objectMode: false }), gzip).then(cleanup, cleanup);
    return { stream: gzip, manifest, filename: `inventar-sicherung-${today()}.tar.gz` };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Writes a backup to a file, or to stdout for `-`. */
export async function writeArchive(target) {
  const { stream, manifest } = await createArchive();
  await pipeline(stream, target === '-' ? process.stdout : fs.createWriteStream(target, { mode: 0o600 }));
  return manifest;
}

// --- Restore ------------------------------------------------------------------

/** Where an archive entry goes in the staging directory, or null to ignore it. */
function stagingTarget(stage, name, size) {
  if (name === 'manifest.json' && size <= 1024 * 1024) return path.join(stage, 'manifest.json');
  if (name === 'inventar.sqlite') return path.join(stage, 'inventar.sqlite');
  if (name === 'app.key' && size <= 1024) return path.join(stage, 'app.key');
  const match = /^uploads\/([0-9a-f]{2})\/([0-9a-f]{32})$/.exec(name);
  if (match && match[2].startsWith(match[1])) return path.join(stage, 'uploads', match[1], match[2]);
  return null;
}

async function extract(input, stage, maxBytes) {
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new RestoreError(`Die Datei ist größer als die eingestellte Grenze von ${formatBytes(maxBytes)} (MAX_RESTORE_MB).`));
      else callback(null, chunk);
    },
  });
  let unpacked = 0;
  let entries = 0;
  const extractor = new TarExtractor({
    open(name, size) {
      unpacked += size;
      entries++;
      if (unpacked > maxBytes * 20 || entries > 2_000_000) throw new RestoreError('Das Archiv ist ungewöhnlich groß und wurde deshalb nicht eingespielt.');
      const target = stagingTarget(stage, name, size);
      if (!target) return null;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      return fs.openSync(target, 'w', 0o600);
    },
  });
  try {
    await pipeline(input, limiter, zlib.createGunzip(), extractor);
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError('Die Datei ist keine gültige oder eine unvollständige Komplettsicherung dieser Anwendung.');
  }
}

/** Checks the staged backup; returns a summary or throws a RestoreError. */
function inspect(stage) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
  } catch {
    manifest = null;
  }
  if (manifest?.format !== FORMAT || !fs.existsSync(path.join(stage, 'inventar.sqlite'))) {
    throw new RestoreError('Die Datei ist keine Komplettsicherung dieser Anwendung.');
  }
  if (manifest.version > FORMAT_VERSION) {
    throw new RestoreError('Die Sicherung stammt aus einer neueren Version dieser Anwendung. Bitte die Anwendung auf diesem Server zuerst aktualisieren.');
  }

  let staged;
  try {
    staged = new Database(path.join(stage, 'inventar.sqlite'), { fileMustExist: true });
    if (staged.pragma('quick_check', { simple: true }) !== 'ok') throw new RestoreError('Die Datenbank in der Sicherung ist beschädigt.');
    const version = staged.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) {
      throw new RestoreError('Die Sicherung stammt aus einer neueren Version dieser Anwendung. Bitte die Anwendung auf diesem Server zuerst aktualisieren.');
    }
    if (version < 1) throw new RestoreError('Die Datenbank in der Sicherung ist leer oder unbekannt.');
    if (!staged.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n) {
      throw new RestoreError('Die Sicherung enthält keinen aktiven Administrator – damit wäre keine Anmeldung möglich.');
    }
    if (staged.prepare('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1').get().n > 0 && !fs.existsSync(path.join(stage, 'app.key'))) {
      throw new RestoreError('In der Sicherung fehlt der Schlüssel für die Zwei-Faktor-Anmeldung.');
    }
    const tokens = staged.prepare('SELECT token FROM attachments').all();
    const missing = tokens.filter(({ token }) => !fs.existsSync(path.join(stage, 'uploads', token.slice(0, 2), token))).length;
    return { createdAt: manifest.created_at ?? null, company: manifest.company ?? '', ...counts(staged), missingFiles: missing };
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError('Die Datenbank in der Sicherung konnte nicht gelesen werden.');
  } finally {
    staged?.close();
  }
}

/** Puts the staged files in place. Synchronous: no request runs in between. */
function apply(stage) {
  replaceDatabase(path.join(stage, 'inventar.sqlite'));
  // Sessions of the old server are not carried over: everybody signs in again.
  run('DELETE FROM sessions');
  run('DELETE FROM login_challenges');
  run('DELETE FROM login_throttle');
  reloadSettings();
  deleteSetting('setup_token');

  const key = path.join(stage, 'app.key');
  if (fs.existsSync(key)) {
    fs.writeFileSync(paths.appKey, fs.readFileSync(key), { mode: 0o600 });
    forgetKey();
  }

  const previous = path.join(paths.tmp, `uploads-alt-${randomId()}`);
  fs.renameSync(paths.uploads, previous);
  fs.renameSync(path.join(stage, 'uploads'), paths.uploads);
  fs.rmSync(previous, { recursive: true, force: true });
}

let busy = false;

/**
 * Restores a backup from a stream of the .tar.gz file into this (fresh)
 * installation. Throws a RestoreError with a German message on any problem;
 * in that case nothing has been changed.
 */
export async function restoreArchive(input, { maxBytes = config.maxRestoreBytes } = {}) {
  if (countUsers() > 0) {
    throw new RestoreError('Diese Installation ist bereits eingerichtet. Eine Sicherung kann nur in eine frische Installation eingespielt werden.');
  }
  if (busy) throw new RestoreError('Es wird gerade bereits eine Sicherung eingespielt.');
  busy = true;
  const stage = path.join(paths.tmp, `restore-${randomId()}`);
  try {
    fs.mkdirSync(path.join(stage, 'uploads'), { recursive: true });
    await extract(input, stage, maxBytes);
    const summary = inspect(stage);
    if (countUsers() > 0) throw new RestoreError('Diese Installation wurde inzwischen eingerichtet. Die Sicherung wurde nicht eingespielt.');
    apply(stage);
    return summary;
  } finally {
    busy = false;
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
