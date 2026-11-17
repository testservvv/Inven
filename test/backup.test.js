// Moving an installation: download a complete backup from one installation
// and restore it into a second, fresh one (running in a child process, because
// the database location is fixed per process).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { Browser } from './helpers.js';

const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventar-quelle-'));
const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventar-ziel-'));
process.env.DATA_DIR = sourceDir;
process.env.SETUP_TOKEN = 'quelle-code';
process.env.BACKUP_KEEP = '0';

const { createApp } = await import('../src/web/app.js');
const { db } = await import('../src/db.js');
const { totp } = await import('../src/lib/totp.js');
const app = createApp();

after(() => {
  db.close();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(targetDir, { recursive: true, force: true });
});

const PASSWORD = 'Korrekt-Pferd-Batterie-7';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const admin = new Browser(app);

/** Names of the entries in a .tar.gz, read with a simple independent parser. */
function tarNames(gz) {
  const tar = zlib.gunzipSync(gz);
  const names = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    names.push(header.toString('utf8', 0, 100).replace(/\0.*$/s, ''));
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim(), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

let archive;
let secret;

test('an admin downloads a complete backup after confirming the password', async () => {
  await admin.post('/setup', { token: 'quelle-code', company: 'Muster GmbH', name: 'Anna Admin', username: 'anna@example.de', password: PASSWORD, password2: PASSWORD });
  await admin.get('/inventar/neu');
  assert.equal((await admin.post('/inventar', { name: 'Wärmebildkamera FLIR E8', purchase_price: '4.890,00' })).location, '/inventar/1');
  const form = new FormData();
  form.set('kind', 'photo');
  form.append('files', new File([PNG], 'kamera.png', { type: 'image/png' }));
  await admin.request('/inventar/1/anhaenge', { method: 'POST', form });
  await admin.post('/inventar/1/defekte', { title: 'Akku hält nicht', severity: 'medium' });
  await admin.post('/nutzer', { name: 'Max Mitarbeiter', username: 'max', role: 'member' });

  const setup = (await admin.get('/konto/2fa')).body;
  secret = /class="totp__secret">([A-Z2-7 ]+)</.exec(setup)[1].replaceAll(' ', '');
  await admin.post('/konto/2fa/aktivieren', { code: totp(secret) });

  const page = (await admin.get('/einstellungen')).body;
  assert.match(page, /Komplettsicherung herunterladen/);
  assert.equal((await admin.post('/einstellungen/sicherung', { password: 'falsch' })).status, 422);
  assert.equal((await new Browser(app).post('/einstellungen/sicherung', { password: PASSWORD })).status, 403);

  const download = await admin.post('/einstellungen/sicherung', { password: PASSWORD });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/gzip');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="inventar-sicherung-\d{4}-\d{2}-\d{2}\.tar\.gz"/);
  archive = download.body;

  const token = db.prepare('SELECT token FROM attachments').get().token;
  assert.deepEqual(tarNames(archive), ['manifest.json', 'inventar.sqlite', 'app.key', `uploads/${token.slice(0, 2)}/${token}`]);
  assert.equal(fs.readdirSync(path.join(sourceDir, 'tmp')).length, 0, 'the temporary database copy is removed');
  assert.match((await admin.get('/aktivitaet')).body, /Komplettsicherung heruntergeladen/);
});

test('the backup restores completely into a fresh installation', () => {
  const file = path.join(targetDir, 'umzug.tar.gz');
  fs.writeFileSync(file, archive);
  const fixture = fileURLToPath(new URL('./fixtures/restore-target.js', import.meta.url));
  const output = execFileSync(process.execPath, [fixture, file, secret, PASSWORD], {
    env: { ...process.env, DATA_DIR: path.join(targetDir, 'data'), SETUP_TOKEN: 'ziel-code', BACKUP_KEEP: '0' },
    encoding: 'utf8',
  });
  const result = JSON.parse(output.trim().split('\n').pop());

  assert.equal(result.wrongToken, 403);
  assert.equal(result.check, 200);
  assert.equal(result.multipart, 400);
  assert.equal(result.garbage.status, 422);
  assert.match(result.garbage.error, /keine gültige/);
  assert.equal(result.foreign.status, 422);
  assert.match(result.foreign.error, /keine Komplettsicherung/);
  assert.equal(result.unchangedAfterFailures, 0, 'failed attempts leave the installation empty');

  assert.equal(result.restore.status, 200);
  assert.deepEqual(
    { assets: result.restore.summary.assets, users: result.restore.summary.users, attachments: result.restore.summary.attachments, missingFiles: result.restore.summary.missingFiles },
    { assets: 1, users: 2, attachments: 1, missingFiles: 0 },
  );
  assert.equal(result.again, 409, 'a second restore is refused');
  assert.equal(result.setupAfter, '/login');
  assert.equal(result.sessionsAfterRestore, 0, 'sessions of the old server are not carried over');

  assert.equal(result.passwordStep, '/login/code?next=%2F', 'two-factor login still works – the key was moved too');
  assert.equal(result.codeStep, '/');
  assert.match(result.assetPage, /Wärmebildkamera FLIR E8/);
  assert.match(result.assetPage, /Akku hält nicht/);
  assert.equal(result.photoHash, sha(PNG));
  assert.equal(result.leftovers, 0, 'staging files are cleaned up');
  assert.match(result.activity, /Sicherung eingespielt/);
});
