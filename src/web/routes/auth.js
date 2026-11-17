// Public routes: first-run setup, login, second factor.
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { html } from 'hono/html';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../../config.js';
import {
  PERSISTENT_MS,
  attemptLogin,
  completeChallenge,
  createChallenge,
  createSession,
  destroySession,
  finishSetup,
  loadChallenge,
  setupToken,
} from '../../services/auth.js';
import { countUsers, createUser, passwordProblem, validateProfile } from '../../services/users.js';
import { setSetting } from '../../services/settings.js';
import { RestoreError, restoreArchive } from '../../services/transfer.js';
import { logEvent } from '../../services/events.js';
import { PASSWORD_MIN_LENGTH, safeEqual } from '../../lib/security.js';
import { cleanText, formatBytes, formatTimestampDate } from '../../lib/format.js';
import { barePage } from '../layout.js';
import { clientIp, readForm, safeNext } from '../http.js';
import { alert, checkbox, errorSummary, field } from '../ui.js';
import { icon } from '../icons.js';

// The __Host- prefix makes browsers refuse the cookie unless it is Secure,
// host-only and set for the whole site – it cannot be planted from a subdomain.
export const SESSION_COOKIE = config.secureCookies ? '__Host-inventar_sid' : 'inventar_sid';
const CHALLENGE_COOKIE = config.secureCookies ? '__Host-inventar_2fa' : 'inventar_2fa';

const cookieBase = { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' };

export function setSessionCookie(c, token, persistent) {
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase, ...(persistent ? { maxAge: PERSISTENT_MS / 1000 } : {}) });
}

export function clearSessionCookie(c) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.secureCookies });
}

/** Signs a user in. Any previous session of this browser is discarded first. */
export function startSession(c, user, persistent) {
  if (c.get('session')) destroySession(c.get('session').id);
  const token = createSession(user.id, { persistent, ip: clientIp(c), userAgent: c.req.header('user-agent') ?? '' });
  setSessionCookie(c, token, persistent);
  logEvent({ user, action: 'auth.login' });
}

const waitText = (seconds) => (seconds < 90 ? `${seconds} Sekunden` : `${Math.ceil(seconds / 60)} Minuten`);

const NOTICES = {
  abgemeldet: 'Du wurdest abgemeldet.',
  passwort: 'Das Passwort wurde geändert. Bitte neu anmelden.',
  abgelaufen: 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.',
  wiederhergestellt: 'Die Sicherung wurde eingespielt. Bitte mit einem bestehenden Konto anmelden.',
};

function loginPage(c, { username = '', next = '/', error = '', notice = '', remember = false }, status = 200) {
  return barePage(
    c,
    {
      title: 'Anmelden',
      content: html`<form method="post" action="/login" class="card card--auth">
        <h1>Anmelden</h1>
        ${error ? alert(error, 'danger', 'circle-alert') : ''}
        ${notice ? alert(notice, 'success', 'circle-check') : ''}
        <input type="hidden" name="next" value="${next}" />
        ${field({ label: 'Benutzername', name: 'username', value: username, required: true, attributes: { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', autofocus: !username } })}
        ${field({ label: 'Passwort', name: 'password', type: 'password', required: true, attributes: { autocomplete: 'current-password', autofocus: Boolean(username) } })}
        ${checkbox({ label: 'Angemeldet bleiben', name: 'remember', checked: remember, hint: '30 Tage auf diesem Gerät' })}
        <button type="submit" class="btn btn--primary btn--block">Anmelden</button>
        <p class="auth__hint">Passwort vergessen? Ein Administrator kann es zurücksetzen.</p>
      </form>`,
    },
    status,
  );
}

function codePage(c, { next, error = '' }, status = 200) {
  return barePage(
    c,
    {
      title: 'Bestätigungscode',
      content: html`<form method="post" action="/login/code" class="card card--auth">
        <h1>Bestätigungscode</h1>
        <p class="muted">Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen deiner Wiederherstellungscodes.</p>
        ${error ? alert(error, 'danger', 'circle-alert') : ''}
        <input type="hidden" name="next" value="${next}" />
        ${field({ label: 'Code', name: 'code', required: true, inputClass: 'input--code', attributes: { autocomplete: 'one-time-code', inputmode: 'text', autocapitalize: 'characters', spellcheck: 'false', autofocus: true, maxlength: 20 } })}
        <button type="submit" class="btn btn--primary btn--block">Bestätigen</button>
        <p class="auth__hint"><a href="/login">Zurück zur Anmeldung</a></p>
      </form>`,
    },
    status,
  );
}

/** Alternative to creating an account: bring in a complete backup from another server. */
function restoreCard(token) {
  return html`<section class="card card--auth card--restore">
    <details class="inline-edit">
      <summary>${icon('hard-drive-download', { size: 16 })}Umzug: Komplettsicherung einspielen</summary>
      <p class="muted">Du ziehst von einem anderen Server um? Dort unter <strong>Einstellungen → Datensicherung &amp; Umzug</strong>
        eine Komplettsicherung herunterladen und hier einspielen. Geräte, Prüfungen, Defekte, Fotos, Belege und alle Konten
        werden vollständig übernommen.</p>
      <form method="post" action="/setup/wiederherstellen" class="form" data-restore-form data-max-bytes="${config.maxRestoreBytes}" data-max-label="${formatBytes(config.maxRestoreBytes)}">
        ${field({ label: 'Einrichtungscode', name: 'token', id: 'f-restore-token', value: token, required: true, hint: 'Derselbe Code wie oben.', attributes: { autocomplete: 'off', spellcheck: 'false' } })}
        <div class="field">
          <label class="field__label" for="f-restore-file">Sicherungsdatei (.tar.gz)</label>
          <input class="input input--file" id="f-restore-file" name="file" type="file" accept=".gz,.tgz,application/gzip" required />
        </div>
        <progress class="progress" max="100" value="0" hidden data-restore-progress></progress>
        <p class="restore__status" role="status" data-restore-status></p>
        <button type="submit" class="btn btn--block">${icon('upload', { size: 16 })}Sicherung einspielen</button>
        <noscript>${alert('Zum Einspielen wird JavaScript benötigt.', 'warning', 'circle-alert')}</noscript>
      </form>
    </details>
  </section>`;
}

function setupPage(c, { values = {}, errors = {}, token = '' }, status = 200) {
  return barePage(
    c,
    {
      title: 'Ersteinrichtung',
      wide: true,
      content: html`<form method="post" action="/setup" class="card card--auth">
        <h1>Willkommen</h1>
        <p class="muted">Lege das erste Administrator-Konto an. Weitere Nutzer kannst du danach in der Anwendung hinzufügen.</p>
        ${errorSummary(errors)}
        ${field({ label: 'Einrichtungscode', name: 'token', value: token, required: true, error: errors.token, hint: 'Steht im Server-Protokoll (docker compose logs app) bzw. in der Konsole.', attributes: { autocomplete: 'off', spellcheck: 'false' } })}
        ${field({ label: 'Firmenname', name: 'company', value: values.company, hint: 'Erscheint in der Kopfzeile und optional auf den QR-Etiketten.', attributes: { maxlength: 80, autocomplete: 'organization' } })}
        ${field({ label: 'Dein Name', name: 'name', value: values.name, required: true, error: errors.name, attributes: { maxlength: 80, autocomplete: 'name' } })}
        ${field({ label: 'Benutzername', name: 'username', value: values.username, required: true, error: errors.username, hint: 'Zum Anmelden, z. B. deine E-Mail-Adresse.', attributes: { maxlength: 64, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' } })}
        ${field({ label: 'Passwort', name: 'password', type: 'password', required: true, error: errors.password, hint: `Mindestens ${PASSWORD_MIN_LENGTH} Zeichen. Ein längerer Satz ist besser als ein kompliziertes Wort.`, attributes: { autocomplete: 'new-password', minlength: PASSWORD_MIN_LENGTH } })}
        ${field({ label: 'Passwort wiederholen', name: 'password2', type: 'password', required: true, error: errors.password2, attributes: { autocomplete: 'new-password' } })}
        <button type="submit" class="btn btn--primary btn--block">${icon('check', { size: 16 })}Konto anlegen</button>
      </form>
      ${restoreCard(token)}`,
    },
    status,
  );
}

export const authRoutes = new Hono();

authRoutes.get('/setup', (c) => {
  if (countUsers() > 0) return c.redirect('/login', 302);
  return setupPage(c, { token: c.req.query('token') ?? '' });
});

authRoutes.post('/setup', async (c) => {
  if (countUsers() > 0) return c.redirect('/login', 303);
  const form = await readForm(c);
  const input = form.values();
  const { values, errors } = validateProfile({ ...input, role: 'admin' });
  if (!safeEqual(form.text('token').trim(), setupToken())) errors.token = 'Der Einrichtungscode stimmt nicht.';
  const problem = passwordProblem(input.password, values);
  if (problem) errors.password = problem;
  else if (input.password !== input.password2) errors.password2 = 'Die Passwörter stimmen nicht überein.';
  values.company = cleanText(input.company, 80);
  if (Object.keys(errors).length > 0) return setupPage(c, { values, errors, token: form.text('token') }, 422);

  const user = await createUser({ ...values, password: input.password });
  if (values.company) setSetting('company_name', values.company);
  finishSetup();
  startSession(c, user, false);
  return c.redirect('/', 303);
});

authRoutes.get('/login', (c) => {
  const next = safeNext(c.req.query('next'));
  if (c.get('user')) return c.redirect(next, 302);
  return loginPage(c, { next, notice: NOTICES[c.req.query('info')] ?? '' });
});

authRoutes.post('/login', async (c) => {
  const form = await readForm(c);
  const username = form.text('username').trim().slice(0, 64);
  const next = safeNext(form.text('next'));
  const remember = form.text('remember') === '1';
  const result = await attemptLogin({ username, password: form.text('password').slice(0, 1000), ip: clientIp(c) });

  if (!result.ok) {
    const error =
      result.reason === 'locked'
        ? `Zu viele Fehlversuche. Bitte in ${waitText(result.wait)} erneut versuchen.`
        : result.reason === 'inactive'
          ? 'Dieses Konto ist deaktiviert. Bitte an einen Administrator wenden.'
          : 'Benutzername oder Passwort ist falsch.';
    return loginPage(c, { username, next, error, remember }, result.reason === 'locked' ? 429 : 401);
  }
  if (result.user.totp_enabled) {
    setCookie(c, CHALLENGE_COOKIE, createChallenge(result.user.id, remember), { ...cookieBase, maxAge: 300 });
    return c.redirect(`/login/code?next=${encodeURIComponent(next)}`, 303);
  }
  startSession(c, result.user, remember);
  return c.redirect(next, 303);
});

authRoutes.get('/login/code', (c) => {
  if (!loadChallenge(getCookie(c, CHALLENGE_COOKIE))) return c.redirect('/login?info=abgelaufen', 302);
  return codePage(c, { next: safeNext(c.req.query('next')) });
});

authRoutes.post('/login/code', async (c) => {
  const form = await readForm(c);
  const next = safeNext(form.text('next'));
  const challenge = loadChallenge(getCookie(c, CHALLENGE_COOKIE));
  if (!challenge) return c.redirect('/login?info=abgelaufen', 303);

  const result = completeChallenge(challenge, form.text('code'), clientIp(c));
  if (!result.ok) {
    if (result.reason === 'expired') {
      deleteCookie(c, CHALLENGE_COOKIE, { path: '/', secure: config.secureCookies });
      return c.redirect('/login?info=abgelaufen', 303);
    }
    const error = result.reason === 'locked' ? `Zu viele Fehlversuche. Bitte in ${waitText(result.wait)} erneut versuchen.` : 'Der Code ist nicht gültig.';
    return codePage(c, { next, error }, result.reason === 'locked' ? 429 : 401);
  }
  deleteCookie(c, CHALLENGE_COOKIE, { path: '/', secure: config.secureCookies });
  startSession(c, result.user, Boolean(challenge.persistent));
  return c.redirect(next, 303);
});

// --- Restoring a complete backup into a fresh installation --------------------
// The browser uploads the .tar.gz file as the raw request body (see app.js),
// so even large archives are streamed straight to disk.

function restoreGuard(c) {
  if (countUsers() > 0) {
    return c.json({ error: 'Diese Installation ist bereits eingerichtet. Eine Sicherung kann nur in eine frische Installation eingespielt werden.' }, 409);
  }
  if (!safeEqual((c.req.header('x-setup-token') ?? '').trim(), setupToken() ?? '')) {
    return c.json({ error: 'Der Einrichtungscode stimmt nicht.' }, 403);
  }
  return null;
}

// Cheap check before a possibly long upload starts.
authRoutes.post('/setup/wiederherstellen/pruefen', (c) => restoreGuard(c) ?? c.json({ ok: true }));

authRoutes.post('/setup/wiederherstellen', async (c) => {
  const refused = restoreGuard(c);
  if (refused) return refused;
  const type = c.req.header('content-type') ?? '';
  if (!c.req.raw.body || type.startsWith('multipart/') || type.startsWith('application/x-www-form-urlencoded')) {
    return c.json({ error: 'Die Sicherungsdatei muss über das Formular mit aktiviertem JavaScript hochgeladen werden.' }, 400);
  }
  if (Number(c.req.header('content-length') || 0) > config.maxRestoreBytes) {
    return c.json({ error: `Die Datei ist größer als die eingestellte Grenze von ${formatBytes(config.maxRestoreBytes)} (MAX_RESTORE_MB).` }, 413);
  }
  try {
    const summary = await restoreArchive(Readable.fromWeb(c.req.raw.body));
    logEvent({
      user: null,
      action: 'backup.restored',
      detail: `Sicherung vom ${formatTimestampDate(summary.createdAt)}: ${summary.assets} Geräte, ${summary.users} Nutzer, ${summary.attachments} Dateien`,
    });
    return c.json({ ok: true, redirect: '/login?info=wiederhergestellt', summary });
  } catch (error) {
    if (error instanceof RestoreError) return c.json({ error: error.message }, 422);
    throw error;
  }
});
