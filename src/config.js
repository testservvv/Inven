// Central configuration, read once from environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All date logic ("is this inspection overdue today?") uses the process time zone.
if (!process.env.TZ) process.env.TZ = 'Europe/Berlin';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Ungültiger Wert für ${name}: "${raw}" (erwartet: ganze Zahl ≥ 0)`);
  }
  return n;
}

function publicUrl(raw) {
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_URL ist keine gültige Adresse: "${raw}" (Beispiel: https://inventar.example.de)`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('APP_URL muss mit https:// oder http:// beginnen');
  }
  return url.origin;
}

const appUrl = publicUrl(env.APP_URL);

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  production: env.NODE_ENV === 'production',
  port: int('PORT', 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),

  /** Public origin, e.g. "https://inventar.example.de". Used for QR links, cookies and origin checks. */
  appUrl,
  /** Cookies get the Secure flag (and HSTS is sent) as soon as the public URL is HTTPS. */
  secureCookies: appUrl.startsWith('https://'),
  /** Number of reverse proxies in front of the app whose X-Forwarded-* headers are trusted. */
  trustProxy: int('TRUST_PROXY', 0),

  maxUploadBytes: int('MAX_UPLOAD_MB', 15) * 1024 * 1024,
  /** Largest backup archive that can be restored through the browser. */
  maxRestoreBytes: int('MAX_RESTORE_MB', 4096) * 1024 * 1024,
  /** Number of daily database snapshots to keep (0 disables the automatic backup). */
  backupKeep: int('BACKUP_KEEP', 14),
  /** Optional fixed token for the first-run setup; generated and logged when empty. */
  setupToken: env.SETUP_TOKEN || '',
};

export const paths = {
  database: path.join(config.dataDir, 'inventar.sqlite'),
  uploads: path.join(config.dataDir, 'uploads'),
  backups: path.join(config.dataDir, 'backups'),
  tmp: path.join(config.dataDir, 'tmp'),
  appKey: path.join(config.dataDir, 'app.key'),
};
