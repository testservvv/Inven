// Child process for backup.test.js: a fresh installation that restores a backup.
// Prints one JSON line with the observations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Browser } from '../helpers.js';

const [file, secret, password] = process.argv.slice(2);
const { createApp } = await import('../../src/web/app.js');
// Namespace import: `db` is replaced by the restore, a destructured copy would go stale.
const database = await import('../../src/db.js');
const { totp } = await import('../../src/lib/totp.js');
const { tarHeader } = await import('../../src/lib/tar.js');
const app = createApp();
const browser = new Browser(app);
const out = {};

const send = (url, body, { token = 'ziel-code', type = 'application/gzip' } = {}) =>
  browser.request(url, { method: 'POST', body, headers: { 'content-type': type, 'x-setup-token': token } });
const json = (response) => JSON.parse(Buffer.from(response.body).toString('utf8'));

out.wrongToken = (await send('/setup/wiederherstellen/pruefen', '', { token: 'falsch' })).status;
out.check = (await send('/setup/wiederherstellen/pruefen', '')).status;
out.multipart = (await send('/setup/wiederherstellen', 'x', { type: 'multipart/form-data; boundary=x' })).status;

let response = await send('/setup/wiederherstellen', crypto.randomBytes(4096));
out.garbage = { status: response.status, error: json(response).error };

const text = Buffer.from('hallo');
const foreign = zlib.gzipSync(Buffer.concat([tarHeader('notiz.txt', text.length), text, Buffer.alloc(507), Buffer.alloc(1024)]));
response = await send('/setup/wiederherstellen', foreign);
out.foreign = { status: response.status, error: json(response).error };
out.unchangedAfterFailures = database.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

response = await send('/setup/wiederherstellen', fs.readFileSync(file));
out.restore = { status: response.status, ...json(response) };
out.again = (await send('/setup/wiederherstellen', fs.readFileSync(file))).status;
out.setupAfter = (await new Browser(app).get('/setup')).location;
out.sessionsAfterRestore = database.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;

const user = new Browser(app);
out.passwordStep = (await user.post('/login', { username: 'anna@example.de', password })).location;
out.codeStep = (await user.post('/login/code', { code: totp(secret, Date.now() + 30_000) })).location;
out.assetPage = (await user.get('/inventar/1')).body;
const token = database.db.prepare('SELECT token FROM attachments').get().token;
out.photoHash = crypto.createHash('sha256').update((await user.get(`/dateien/${token}/x.png`)).body).digest('hex');
out.activity = (await user.get('/aktivitaet')).body;
out.leftovers = fs.readdirSync(path.join(process.env.DATA_DIR, 'tmp')).length;

database.db.close();
console.log(JSON.stringify(out));
