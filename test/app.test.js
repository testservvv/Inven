// End-to-end tests against the real application (HTTP layer, database, files)
// using a throwaway data directory. The tests build on each other, in order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventar-test-'));
process.env.DATA_DIR = dataDir;
process.env.SETUP_TOKEN = 'einrichtung-test';
process.env.BACKUP_KEEP = '0';

const { createApp } = await import('../src/web/app.js');
const { db } = await import('../src/db.js');
const { totp } = await import('../src/lib/totp.js');
const { addMonths, formatDate, today } = await import('../src/lib/format.js');
const app = createApp();

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ORIGIN = 'http://localhost';
const PASSWORD = 'Korrekt-Pferd-Batterie-7';

/** Minimal browser: keeps cookies and sends the CSRF token of the last page. */
class Browser {
  cookies = new Map();
  csrf = '';

  async request(url, { method = 'GET', form, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.cookies.size > 0) init.headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') {
      if (!('origin' in init.headers)) init.headers.origin = ORIGIN;
      if (form instanceof FormData) {
        if (!form.has('_csrf')) form.set('_csrf', this.csrf);
        init.body = form;
      } else {
        init.body = new URLSearchParams({ _csrf: this.csrf, ...form });
        init.headers['content-type'] = 'application/x-www-form-urlencoded';
      }
    }
    const response = await app.request(url, init);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
      if (value === '' || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('text/') ? await response.text() : Buffer.from(await response.arrayBuffer());
    if (typeof body === 'string') {
      const token = /name="_csrf" value="([^"]+)"/.exec(body)?.[1];
      if (token) this.csrf = token;
    }
    return { status: response.status, location: response.headers.get('location'), headers: response.headers, body };
  }

  get(url) {
    return this.request(url);
  }

  post(url, form = {}, headers = {}) {
    return this.request(url, { method: 'POST', form, headers });
  }

  async login(username, password, extra = {}) {
    return this.post('/login', { username, password, ...extra });
  }
}

const admin = new Browser();
const member = new Browser();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNkYPhfz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
const file = (bytes, name, type) => new File([bytes], name, { type });

test('a fresh installation only offers the setup page', async () => {
  assert.equal((await admin.get('/')).location, '/setup');
  assert.equal((await admin.get('/login')).location, '/setup');
  assert.equal((await admin.get('/healthz')).status, 200);

  const page = await admin.get('/setup');
  assert.equal(page.status, 200);
  for (const header of ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']) {
    assert.ok(page.headers.get(header), `${header} is set`);
  }
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.body, /einrichtung-test/, 'the setup token is never rendered');
});

test('setup needs the token from the server log and a decent password', async () => {
  const base = { company: 'Muster GmbH', name: 'Anna Admin', username: 'anna@example.de', password: PASSWORD, password2: PASSWORD };
  assert.equal((await admin.post('/setup', { ...base, token: 'falsch' })).status, 422);
  assert.equal((await admin.post('/setup', { ...base, token: 'einrichtung-test', password: 'Passwort2026!', password2: 'Passwort2026!' })).status, 422);
  assert.equal((await admin.post('/setup', { ...base, token: 'einrichtung-test', password2: 'anders' })).status, 422);

  const done = await admin.post('/setup', { ...base, token: 'einrichtung-test' });
  assert.equal(done.status, 303);
  assert.equal(done.location, '/');
  assert.match(done.headers.getSetCookie().join(';'), /inventar_sid=[^;]+; .*HttpOnly; .*SameSite=Lax/i);
  assert.match((await admin.get('/')).body, /Hallo Anna/);
  assert.equal((await new Browser().get('/setup')).location, '/login', 'setup is closed afterwards');
});

test('pages require a login and never redirect to foreign sites', async () => {
  const guest = new Browser();
  assert.equal((await guest.get('/inventar?q=x')).location, '/login?next=%2Finventar%3Fq%3Dx');
  assert.equal((await guest.post('/inventar', { name: 'x' })).status, 403);
  assert.equal((await guest.get('/dateien/00000000000000000000000000000000/x.png')).status, 302);
  assert.equal((await guest.get('/export/inventar.csv')).status, 302);

  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
    const session = new Browser();
    const result = await session.login('anna@example.de', PASSWORD, { next });
    assert.equal(result.location, '/', `next=${next} is ignored`);
  }
  const session = new Browser();
  assert.equal((await session.login('anna@example.de', PASSWORD, { next: '/defekte' })).location, '/defekte');
});

test('state-changing requests need a CSRF token and the right origin', async () => {
  await admin.get('/inventar/neu');
  const good = admin.csrf;
  admin.csrf = 'gefaelscht';
  assert.equal((await admin.post('/stammdaten/standorte', { name: 'Ohne Token' })).status, 403);
  admin.csrf = good;
  assert.equal((await admin.post('/stammdaten/standorte', { name: 'Fremd' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await admin.post('/stammdaten/standorte', { name: 'Labor' })).status, 303);
  const page = (await admin.get('/stammdaten')).body;
  assert.match(page, /Labor/);
  assert.doesNotMatch(page, /Ohne Token|Fremd/);
});

test('devices: create, validate, escape, edit, search and sort', async () => {
  const created = await admin.post('/inventar', {
    name: '<script>alert(1)</script> Oszilloskop', category_id: '__new', category_new: 'Prüfmittel', location_id: '__new', location_new: 'Werkstatt',
    serial_number: 'SN-4711', purchase_date: '2024-03-15', purchase_price: '1.249,00', status: 'active', ownership: 'owned', plan_1: '1', plan_interval_1: '24', plan_due_1: '2026-01-10',
  });
  assert.equal(created.status, 303);
  assert.equal(created.location, '/inventar/1');

  const detail = (await admin.get('/inventar/1')).body;
  assert.match(detail, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Oszilloskop/);
  assert.doesNotMatch(detail, /<script>alert/);
  assert.match(detail, /INV-0001/);
  assert.match(detail, /1\.249,00/);
  assert.match(detail, /alle 24 Monate/);
  assert.match(detail, /Überfällig/);

  assert.equal((await admin.post('/inventar', { name: '', inventory_number: 'INV-0001', purchase_price: 'viel' })).status, 422);
  assert.equal((await admin.post('/inventar', { name: 'Zweites Gerät', inventory_number: 'inv-0001' })).status, 422, 'inventory numbers are unique, ignoring case');
  assert.equal((await admin.post('/inventar', { name: 'Multimeter', manufacturer: 'Fluke', insured_value: '500' })).location, '/inventar/2');

  assert.equal((await admin.post('/inventar/2', { name: 'Multimeter 87V', inventory_number: 'INV-0002', status: 'repair', manufacturer: 'Fluke' })).status, 303);
  const edited = (await admin.get('/inventar/2')).body;
  assert.match(edited, /Multimeter 87V/);
  assert.match(edited, /Status: In Betrieb → In Reparatur/, 'changes are logged');

  const found = (await admin.get('/inventar?q=fluke')).body;
  assert.match(found, /Multimeter 87V/);
  assert.doesNotMatch(found, /Oszilloskop/);
  assert.match((await admin.get("/inventar?q=%25'%20OR%201=1--")).body, /Keine Treffer/);
  assert.equal((await admin.get('/inventar?sort=drop%20table&dir=x&seite=abc&zustand=overdue')).status, 200);
  assert.equal((await admin.get('/inventar/999')).status, 404);
  assert.equal((await admin.get('/inventar/1/qr.svg')).headers.get('content-type'), 'image/svg+xml; charset=utf-8');
});

let memberPassword = '';

test('admins create users with a one-time password that must be changed', async () => {
  const created = await admin.post('/nutzer', { name: 'Max Mitarbeiter', username: 'max', role: 'member' });
  assert.equal(created.status, 200);
  const temporary = /id="temp-password">([^<]+)</.exec(created.body)[1];
  assert.match(temporary, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.equal((await admin.post('/nutzer', { name: 'Doppelt', username: 'MAX', role: 'member' })).status, 422);

  assert.equal((await member.login('max', temporary)).status, 303);
  assert.equal((await member.get('/inventar')).location, '/konto/passwort', 'nothing else is reachable yet');
  await member.get('/konto/passwort');
  memberPassword = 'Gruene-Wiese-Am-Fluss-9';
  assert.equal((await member.post('/konto/passwort', { current: temporary, password: 'Mitarbeiter-2026-x', password2: 'Mitarbeiter-2026-x' })).status, 422);
  assert.equal((await member.post('/konto/passwort', { current: 'falsch', password: memberPassword, password2: memberPassword })).status, 422);
  assert.equal((await member.post('/konto/passwort', { current: temporary, password: memberPassword, password2: memberPassword })).status, 303);
  assert.equal((await member.get('/inventar')).status, 200);
});

test('members can view, report and inspect – but not manage', async () => {
  for (const url of ['/nutzer', '/nutzer/1', '/stammdaten', '/einstellungen', '/aktivitaet', '/daten', '/export/inventar.csv', '/etiketten', '/etiketten/pdf', '/inventar/neu', '/inventar/1/bearbeiten']) {
    assert.equal((await member.get(url)).status, 403, `GET ${url}`);
  }
  await member.get('/inventar/1');
  for (const [url, form] of [
    ['/inventar', { name: 'Schmuggelware' }],
    ['/inventar/1', { name: 'Umbenannt', inventory_number: 'INV-0001' }],
    ['/inventar/1/loeschen', { _confirmed: '1' }],
    ['/inventar/1/pruefplaene', { type_id: '2' }],
    ['/nutzer', { name: 'Hacker', username: 'hacker', role: 'admin' }],
    ['/nutzer/2', { name: 'Max', username: 'max', role: 'admin', active: '1' }],
    ['/nutzer/1/passwort', { _confirmed: '1' }],
    ['/einstellungen', { warn_days: '1' }],
    ['/stammdaten/kategorien', { name: 'Neu' }],
    ['/import', {}],
  ]) {
    assert.equal((await member.post(url, form)).status, 403, `POST ${url}`);
  }

  const detail = (await member.get('/inventar/1')).body;
  assert.doesNotMatch(detail, /Anschaffungspreis|1\.249,00|Bearbeiten/, 'prices and admin actions are hidden');
  assert.doesNotMatch((await member.get('/')).body, /Versicherungswert/);

  const defect = new FormData();
  defect.set('title', 'Display flackert');
  defect.set('severity', 'critical');
  defect.set('origin', 'scan');
  defect.append('photos', file(PNG, 'foto.png', 'image/png'));
  const reported = await member.request('/inventar/1/defekte', { method: 'POST', form: defect });
  assert.equal(reported.status, 303);
  assert.match(reported.location, /^\/q\/[A-Z0-9]{8}$/, 'returns to the scan view');
  const scan = (await member.get(reported.location)).body;
  assert.match(scan, /Defekt melden/);
  assert.match(scan, /Display flackert/);
  assert.equal((await member.get(reported.location.toLowerCase())).status, 200, 'codes are case-insensitive');
  assert.equal((await member.get('/q/XXXXXXXX')).status, 404);

  assert.equal((await member.post('/inventar/1/defekte', { title: '', severity: 'schlimm' })).status, 422);
  assert.equal((await member.post('/defekte/1', { status: 'resolved', resolution: 'Kabel getauscht', title: 'Manipuliert', repair_cost: '99' })).status, 303);
  const resolved = (await admin.get('/defekte/1')).body;
  assert.match(resolved, /Behoben/);
  assert.match(resolved, /Display flackert/, 'members cannot rewrite the report');
  assert.doesNotMatch(resolved, /Manipuliert/);
  assert.equal((await member.post('/defekte/1/loeschen', { _confirmed: '1' })).status, 403);
});

test('inspections update the plan and its due date', async () => {
  const day = today();
  assert.equal((await member.post('/inventar/1/pruefungen', { type_id: '1', performed_on: '2999-01-01', result: 'passed' })).status, 422);
  assert.equal((await member.post('/inventar/1/pruefungen', { type_id: '99', performed_on: day, result: 'vielleicht' })).status, 422);

  const saved = await member.post('/inventar/1/pruefungen', { type_id: '1', performed_on: day, result: 'passed', inspector: 'Kalibrierlabor Nord', certificate_number: 'KL-1' });
  assert.equal(saved.status, 303);
  let detail = (await admin.get('/inventar/1')).body;
  assert.match(detail, new RegExp(`Fällig: ${formatDate(addMonths(day, 24)).replaceAll('.', '\\.')}`), 'own interval of 24 months is used');
  assert.match(detail, /In Ordnung/);
  assert.match(detail, /Kalibrierlabor Nord/);

  // A failed inspection of another type creates the plan and a critical defect.
  assert.equal((await member.post('/inventar/1/pruefungen', { type_id: '2', performed_on: day, result: 'failed', notes: 'Isolationsfehler', create_defect: '1' })).status, 303);
  detail = (await admin.get('/inventar/1')).body;
  assert.match(detail, /Nicht bestanden/);
  assert.match(detail, /nicht bestanden<\/a>/, 'defect was created');
  assert.match((await admin.get('/pruefungen?stand=overdue')).body, /Oszilloskop/);
  assert.match((await admin.get('/pruefungen?ansicht=protokoll')).body, /KL-1/);

  // Deleting the failed record resets the plan.
  const id = db.prepare("SELECT id FROM inspections WHERE result = 'failed'").get().id;
  assert.equal((await member.post(`/pruefungen/${id}/loeschen`, { _confirmed: '1' })).status, 403);
  const unconfirmed = await admin.post(`/pruefungen/${id}/loeschen`);
  assert.equal(unconfirmed.status, 200, 'without confirmation a confirmation page is shown');
  assert.match(unconfirmed.body, /name="_confirmed" value="1"/);
  assert.equal((await admin.post(`/pruefungen/${id}/loeschen`, { _confirmed: '1' })).status, 303);
  assert.deepEqual({ ...db.prepare('SELECT last_result, next_due FROM inspection_plans WHERE asset_id = 1 AND type_id = 2').get() }, { last_result: null, next_due: null });
});

test('uploads: only real images and PDFs, invoices hidden from members', async () => {
  const upload = async (bytes, name, kind) => {
    const form = new FormData();
    form.set('kind', kind);
    form.append('files', file(bytes, name, 'image/png'));
    return admin.request('/inventar/1/anhaenge', { method: 'POST', form });
  };
  await admin.get('/inventar/1');
  await upload(Buffer.from('<html><script>alert(1)</script>'), 'harmlos.png', 'photo');
  assert.match((await admin.get('/inventar/1')).body, /nicht unterstütztes Format/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE kind != 'photo' OR defect_id IS NULL").get().n, 0);

  assert.equal((await upload(PNG, '../../etc/passwd.png', 'photo')).status, 303);
  assert.equal((await upload(Buffer.from('%PDF-1.4 rechnung'), 'Rechnung 2024.pdf', 'invoice')).status, 303);
  const photo = db.prepare("SELECT * FROM attachments WHERE kind = 'photo' AND defect_id IS NULL").get();
  const invoice = db.prepare("SELECT * FROM attachments WHERE kind = 'invoice'").get();
  assert.equal(photo.filename, 'passwd.png', 'paths are stripped from file names');
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', photo.token.slice(0, 2), photo.token)));

  const served = await admin.get(`/dateien/${photo.token}/x.png`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(served.body, PNG);

  assert.equal((await admin.get(`/dateien/${invoice.token}/r.pdf`)).status, 200);
  assert.equal((await member.get(`/dateien/${invoice.token}/r.pdf`)).status, 404);
  assert.equal((await member.get(`/dateien/${photo.token}/x.png`)).status, 200);
  assert.doesNotMatch((await member.get('/inventar/1')).body, new RegExp(invoice.token));
  assert.equal((await admin.get('/dateien/..%2F..%2Finventar.sqlite/x')).status, 404);

  assert.equal((await admin.post(`/anhaenge/${photo.id}/loeschen`, { _confirmed: '1' })).status, 303);
  assert.ok(!fs.existsSync(path.join(dataDir, 'uploads', photo.token.slice(0, 2), photo.token)), 'file is removed from disk');
});

test('CSV export can be imported again; labels are rendered as PDF', async () => {
  const exported = await admin.get('/export/inventar.csv');
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="inventar-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(exported.body, /^Inventarnummer;Bezeichnung;/);
  assert.match(exported.body, /INV-0002;Multimeter 87V/);

  const csv = `${exported.body.trim()}\r\n;Neues Netzteil;Messtechnik;Korad;;;In Betrieb;Lager;;;;01.02.2025;119,90;;;;;;=HYPERLINK("x");${formatDate(addMonths(today(), 2))};;;\r\n;;;;;;;;;;;;;;;;;;;;;;\r\nINV-0002;;;;;;Kaputt;;;;;;;;;;;;;;;;\r\n`;
  const form = new FormData();
  form.append('file', file(Buffer.from(csv, 'utf8'), 'inventar.csv', 'text/csv'));
  const check = await admin.request('/import', { method: 'POST', form });
  assert.equal(check.status, 200);
  assert.match(check.body, /1 neu/);
  assert.match(check.body, /Inventarnummer existiert bereits/);
  const token = /name="token" value="([a-f0-9]{32})"/.exec(check.body)[1];
  const mapping = Object.fromEntries([...check.body.matchAll(/name="(map_[^"]+)">([\s\S]*?)<\/select>/g)].map(([, name, options]) => [name, /value="(\d+)" selected/.exec(options)?.[1] ?? '']));
  assert.equal(mapping.map_name, '1');

  const recheck = await admin.post('/import/pruefen', { token, ...mapping, update: '1' });
  assert.match(recheck.body, /2 zu aktualisieren/);
  assert.match(recheck.body, /Unbekannter Status/);
  const run = await admin.post('/import/ausfuehren', { token, ...mapping, update: '1' });
  assert.equal(run.status, 303);
  const imported = db.prepare("SELECT * FROM assets WHERE name = 'Neues Netzteil'").get();
  assert.equal(imported.inventory_number, 'INV-0003');
  assert.equal(imported.purchase_price_cents, 11990);
  assert.equal(imported.notes, '=HYPERLINK("x")');
  assert.equal(db.prepare('SELECT next_due FROM inspection_plans WHERE asset_id = ?').get(imported.id).next_due, addMonths(today(), 2));
  assert.equal(db.prepare('SELECT status FROM assets WHERE id = 2').get().status, 'repair', 'invalid rows change nothing');
  assert.equal((await admin.post('/import/ausfuehren', { token, ...mapping })).status, 303, 'an upload cannot be imported twice');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE name = 'Neues Netzteil'").get().n, 1);

  const pdf = await admin.get('/etiketten/pdf?format=roll-62x29&ids=1,2&vorschau=1');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  for (const url of ['/', '/defekte?status=all', '/pruefungen', '/etiketten', '/stammdaten', '/daten', '/nutzer', '/aktivitaet', '/einstellungen', '/konto', '/mehr', '/scannen', '/export/defekte.csv', '/export/pruefungen.csv', '/export/pruefprotokoll.csv', '/export/vorlage.csv']) {
    assert.equal((await admin.get(url)).status, 200, url);
  }
});

test('repeated wrong passwords lock the login for a while', async () => {
  db.exec('DELETE FROM login_throttle'); // earlier tests already produced failed attempts
  const attacker = new Browser();
  for (let i = 0; i < 5; i++) assert.equal((await attacker.login('max', `falsch-${i}`)).status, 401);
  const locked = await attacker.login('max', memberPassword);
  assert.equal(locked.status, 429, 'even the right password is refused while locked');
  assert.match(locked.body, /Zu viele Fehlversuche/);
  assert.equal((await attacker.login('gibt-es-nicht', 'egal')).status, 401);
  assert.match((await attacker.login('gibt-es-nicht', 'egal')).body, /Benutzername oder Passwort ist falsch/);
  assert.equal((await member.get('/inventar')).status, 200, 'existing sessions keep working');
});

test('two-factor login with authenticator codes and recovery codes', async () => {
  const setup = (await admin.get('/konto/2fa')).body;
  const secret = /class="totp__secret">([A-Z2-7 ]+)</.exec(setup)[1].replaceAll(' ', '');
  assert.equal((await admin.post('/konto/2fa/aktivieren', { code: '000000' })).status, 422);
  const activated = await admin.post('/konto/2fa/aktivieren', { code: totp(secret) });
  assert.equal(activated.status, 200);
  const codes = [...activated.body.matchAll(/<li>([A-Z0-9]{5}-[A-Z0-9]{5})<\/li>/g)].map((match) => match[1]);
  assert.equal(codes.length, 10);
  assert.doesNotMatch(db.prepare('SELECT totp_secret FROM users WHERE id = 1').get().totp_secret, new RegExp(secret), 'the secret is stored encrypted');

  const session = new Browser();
  const first = await session.login('anna@example.de', PASSWORD, { next: '/defekte' });
  assert.equal(first.location, '/login/code?next=%2Fdefekte');
  assert.equal((await session.get('/inventar')).status, 302, 'the password alone does not sign in');
  assert.equal((await session.post('/login/code', { code: '123456' })).status, 401);
  assert.equal((await session.post('/login/code', { code: totp(secret) })).status, 401, 'the code used for activation cannot be replayed');
  const second = await session.post('/login/code', { code: totp(secret, Date.now() + 30_000), next: '/defekte' });
  assert.equal(second.location, '/defekte');
  assert.equal((await session.get('/inventar')).status, 200);

  const recovery = new Browser();
  await recovery.login('anna@example.de', PASSWORD);
  assert.equal((await recovery.post('/login/code', { code: codes[0].toLowerCase() })).status, 303);
  const again = new Browser();
  await again.login('anna@example.de', PASSWORD);
  assert.equal((await again.post('/login/code', { code: codes[0] })).status, 401, 'recovery codes work only once');

  assert.equal((await admin.post('/konto/2fa/deaktivieren', { password: 'falsch' })).status, 422);
  assert.equal((await admin.post('/konto/2fa/deaktivieren', { password: PASSWORD })).status, 303);
  assert.equal((await new Browser().login('anna@example.de', PASSWORD)).location, '/');
});

test('account safety nets: last admin, deactivation, logout', async () => {
  await admin.get('/nutzer/1');
  assert.equal((await admin.post('/nutzer/1', { name: 'Anna Admin', username: 'anna@example.de', role: 'member', active: '1' })).status, 422, 'the last admin cannot be demoted');
  assert.equal((await admin.post('/nutzer/1', { name: 'Anna Admin', username: 'anna@example.de', role: 'admin' })).status, 422, 'the last admin cannot be deactivated');
  assert.equal((await admin.post('/nutzer/1/loeschen', { _confirmed: '1' })).location, '/nutzer/1');

  assert.equal((await admin.post('/nutzer/2', { name: 'Max Mitarbeiter', username: 'max', role: 'member' })).status, 303);
  assert.equal((await member.get('/inventar')).status, 302, 'deactivating a user ends their sessions');

  const cookie = admin.cookies.get('inventar_sid');
  assert.equal((await admin.post('/logout')).location, '/login?info=abgemeldet');
  const stale = new Browser();
  stale.cookies.set('inventar_sid', cookie);
  assert.equal((await stale.get('/inventar')).status, 302, 'the old session cookie is worthless after logout');
});
