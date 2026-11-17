// "Mein Konto": profile, password, two-factor authentication, sessions.
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import {
  confirmPassword,
  confirmTotpEnrollment,
  destroyOtherSessions,
  destroySession,
  disableTotp,
  listSessions,
  pendingTotpSecret,
  regenerateRecoveryCodes,
  remainingRecoveryCodes,
} from '../../services/auth.js';
import { getUser, passwordProblem, renameSelf, setPassword } from '../../services/users.js';
import { companyName } from '../../services/settings.js';
import { logEvent } from '../../services/events.js';
import { PASSWORD_MIN_LENGTH } from '../../lib/security.js';
import { formatSecret, otpauthUrl } from '../../lib/totp.js';
import { qrSvg } from '../../lib/qr.js';
import { cleanText, formatDateTime } from '../../lib/format.js';
import { ROLE } from '../../lib/terms.js';
import { barePage, navigation, page } from '../layout.js';
import { clientIp, readForm, redirect } from '../http.js';
import { alert, badge, card, csrfField, details, errorSummary, field, pageHeader, postButton } from '../ui.js';
import { icon } from '../icons.js';
import { clearSessionCookie } from './auth.js';

export const accountRoutes = new Hono();

accountRoutes.post('/logout', (c) => {
  destroySession(c.get('session').id);
  clearSessionCookie(c);
  return c.redirect('/login?info=abgemeldet', 303);
});

/** Short description of a browser from its User-Agent string. */
function describeAgent(agent) {
  const text = String(agent ?? '');
  const browser = /Edg\//.test(text) ? 'Edge' : /Firefox\//.test(text) ? 'Firefox' : /Chrome\//.test(text) ? 'Chrome' : /Safari\//.test(text) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(text) ? 'iOS' : /Android/.test(text) ? 'Android' : /Windows/.test(text) ? 'Windows' : /Mac OS X/.test(text) ? 'macOS' : /Linux/.test(text) ? 'Linux' : '';
  return system ? `${browser} · ${system}` : browser;
}

function passwordForm(c, { errors = {}, forced = false }) {
  return html`<form method="post" action="/konto/passwort" class="form">
    ${csrfField(c)}
    ${errorSummary(errors)}
    ${field({ label: forced ? 'Vorläufiges Passwort' : 'Aktuelles Passwort', name: 'current', type: 'password', required: true, error: errors.current, attributes: { autocomplete: 'current-password' } })}
    ${field({ label: 'Neues Passwort', name: 'password', type: 'password', required: true, error: errors.password, hint: `Mindestens ${PASSWORD_MIN_LENGTH} Zeichen.`, attributes: { autocomplete: 'new-password', minlength: PASSWORD_MIN_LENGTH } })}
    ${field({ label: 'Neues Passwort wiederholen', name: 'password2', type: 'password', required: true, error: errors.password2, attributes: { autocomplete: 'new-password' } })}
    <div class="form-actions"><button type="submit" class="btn btn--primary">Passwort ändern</button></div>
  </form>`;
}

function accountPage(c, { errors = {}, section = '' } = {}, status = 200) {
  const user = c.get('user');
  const session = c.get('session');
  const sessions = listSessions(user.id);
  const content = html`${pageHeader({ title: 'Mein Konto', subtitle: `${user.username} · ${ROLE[user.role]}` })}
    <div class="stack">
      ${card({
        title: 'Profil',
        body: html`<form method="post" action="/konto/profil" class="form form--inline">
          ${csrfField(c)}
          ${field({ label: 'Name', name: 'name', value: user.name, required: true, error: section === 'profile' ? errors.name : '', attributes: { maxlength: 80, autocomplete: 'name' } })}
          <button type="submit" class="btn">Speichern</button>
        </form>`,
      })}
      ${card({ title: 'Passwort', body: passwordForm(c, { errors: section === 'password' ? errors : {} }) })}
      ${card({
        title: 'Zwei-Faktor-Schutz',
        action: user.totp_enabled ? badge('Aktiv', 'success') : badge('Nicht aktiv', 'neutral'),
        body: user.totp_enabled
          ? html`<p>Beim Anmelden wird zusätzlich ein Code aus deiner Authenticator-App abgefragt.
              Noch ${remainingRecoveryCodes(user.id)} unbenutzte Wiederherstellungscodes.</p>
              <p><a class="btn" href="/konto/2fa">${icon('shield-check', { size: 16 })}Verwalten</a></p>`
          : html`<p>Schütze dein Konto zusätzlich mit einem Einmalcode aus einer Authenticator-App
              (z. B. Google Authenticator, Microsoft Authenticator, Aegis, 2FAS). Selbst ein gestohlenes Passwort reicht dann nicht zum Anmelden.</p>
              <p><a class="btn btn--primary" href="/konto/2fa">${icon('shield-check', { size: 16 })}Jetzt einrichten</a></p>`,
      })}
      ${card({
        title: 'Angemeldete Geräte',
        action: sessions.length > 1 ? postButton(c, { action: '/konto/sitzungen/beenden', label: 'Alle anderen abmelden', className: 'btn btn--sm' }) : '',
        flush: true,
        body: html`<ul class="list">
          ${sessions.map(
            (item) => html`<li class="list__item">
              <span class="list__icon">${icon('monitor-smartphone')}</span>
              <span class="list__main"><strong>${describeAgent(item.user_agent)}</strong>
                <span class="muted">Zuletzt aktiv ${formatDateTime(item.last_seen_at)}${item.ip ? ` · ${item.ip}` : ''}</span></span>
              ${item.id === session.id ? badge('Dieses Gerät', 'info') : ''}
            </li>`,
          )}
        </ul>`,
      })}
    </div>`;
  return page(c, { title: 'Mein Konto', active: 'account', narrow: true, content }, status);
}

accountRoutes.get('/konto', (c) => accountPage(c));

accountRoutes.post('/konto/profil', async (c) => {
  const name = cleanText((await readForm(c)).text('name'), 80);
  if (!name) return accountPage(c, { errors: { name: 'Bitte einen Namen angeben.' }, section: 'profile' }, 422);
  renameSelf(c.get('user').id, name);
  return redirect(c, '/konto', 'Profil gespeichert.');
});

// Users with a temporary password land here and cannot go anywhere else first.
accountRoutes.get('/konto/passwort', (c) => {
  if (!c.get('user').must_change_password) return c.redirect('/konto', 302);
  return barePage(c, {
    title: 'Neues Passwort',
    content: html`<div class="card card--auth">
      <h1>Neues Passwort festlegen</h1>
      <p class="muted">Du hast ein vorläufiges Passwort erhalten. Bitte lege jetzt dein eigenes fest.</p>
      ${passwordForm(c, { forced: true })}
      <form method="post" action="/logout" class="auth__hint">${csrfField(c)}<button type="submit" class="link-btn">Abmelden</button></form>
    </div>`,
  });
});

accountRoutes.post('/konto/passwort', async (c) => {
  const user = c.get('user');
  const form = await readForm(c);
  const errors = {};
  const password = form.text('password');
  if (!(await confirmPassword(user, form.text('current'), clientIp(c)))) {
    errors.current = 'Das aktuelle Passwort stimmt nicht.';
  } else {
    const problem = passwordProblem(password, user);
    if (problem) errors.password = problem;
    else if (password === form.text('current')) errors.password = 'Das neue Passwort muss sich vom bisherigen unterscheiden.';
    else if (password !== form.text('password2')) errors.password2 = 'Die Passwörter stimmen nicht überein.';
  }
  if (Object.keys(errors).length > 0) {
    if (user.must_change_password) {
      return barePage(c, {
        title: 'Neues Passwort',
        content: html`<div class="card card--auth"><h1>Neues Passwort festlegen</h1>${passwordForm(c, { errors, forced: true })}</div>`,
      }, 422);
    }
    return accountPage(c, { errors, section: 'password' }, 422);
  }
  await setPassword(user.id, password);
  destroyOtherSessions(user.id, c.get('session').id);
  logEvent({ user, action: 'auth.password_changed' });
  return redirect(c, user.must_change_password ? '/' : '/konto', 'Passwort geändert. Andere Geräte wurden abgemeldet.');
});

accountRoutes.post('/konto/sitzungen/beenden', (c) => {
  destroyOtherSessions(c.get('user').id, c.get('session').id);
  return redirect(c, '/konto', 'Alle anderen Geräte wurden abgemeldet.');
});

// --- Two-factor authentication ----------------------------------------------
function recoveryCodesPage(c, codes, intro) {
  return page(c, {
    title: 'Wiederherstellungscodes',
    active: 'account',
    narrow: true,
    content: html`${pageHeader({ title: 'Wiederherstellungscodes', back: { href: '/konto', label: 'Mein Konto' } })}
      ${card({
        body: html`${alert(html`<strong>${intro}</strong> Bewahre diese Codes sicher auf (Passwort-Manager oder Ausdruck). Jeder Code funktioniert genau einmal und ersetzt den Code aus der App, falls du dein Handy verlierst. Sie werden nur jetzt angezeigt.`, 'warning', 'key-round')}
          <ul class="codes" id="recovery-codes">${codes.map((code) => html`<li>${code}</li>`)}</ul>
          <div class="form-actions">
            <button type="button" class="btn" data-copy="#recovery-codes">${icon('copy', { size: 16 })}Kopieren</button>
            <a class="btn btn--primary" href="/konto">Ich habe die Codes gesichert</a>
          </div>`,
      })}`,
  });
}

function twoFactorPage(c, { error = '' } = {}, status = 200) {
  const user = getUser(c.get('user').id);
  let body;
  if (user.totp_enabled) {
    body = html`${card({
        title: 'Status',
        action: badge('Aktiv', 'success'),
        body: details([['Unbenutzte Wiederherstellungscodes', String(remainingRecoveryCodes(user.id))]]),
      })}
      ${card({
        title: 'Neue Wiederherstellungscodes',
        body: html`<p class="muted">Erzeugt zehn neue Codes. Die bisherigen werden damit ungültig.</p>
          <form method="post" action="/konto/2fa/codes" class="form form--inline">
            ${csrfField(c)}
            ${field({ label: 'Passwort zur Bestätigung', name: 'password', id: 'f-confirm-codes', type: 'password', required: true, attributes: { autocomplete: 'current-password' } })}
            <button type="submit" class="btn">Neue Codes erzeugen</button>
          </form>`,
      })}
      ${card({
        title: 'Zwei-Faktor-Schutz deaktivieren',
        body: html`<p class="muted">Danach genügt wieder das Passwort allein zum Anmelden.</p>
          <form method="post" action="/konto/2fa/deaktivieren" class="form form--inline">
            ${csrfField(c)}
            ${field({ label: 'Passwort zur Bestätigung', name: 'password', id: 'f-confirm-disable', type: 'password', required: true, attributes: { autocomplete: 'current-password' } })}
            <button type="submit" class="btn btn--danger">Deaktivieren</button>
          </form>`,
      })}`;
  } else {
    const secret = pendingTotpSecret(user);
    const url = otpauthUrl({ issuer: companyName() || 'Inventar', account: user.username, secret });
    body = card({
      body: html`<ol class="steps">
          <li><strong>App öffnen.</strong> Installiere eine Authenticator-App auf deinem Handy, falls noch nicht vorhanden.</li>
          <li><strong>QR-Code scannen.</strong>
            <div class="totp">
              <div class="totp__qr">${raw(qrSvg(url, { margin: 3 }))}</div>
              <div><p class="muted">Oder diesen Schlüssel von Hand eingeben:</p><code class="totp__secret">${formatSecret(secret)}</code></div>
            </div></li>
          <li><strong>Code bestätigen.</strong> Gib den 6-stelligen Code ein, den die App anzeigt.
            <form method="post" action="/konto/2fa/aktivieren" class="form form--inline">
              ${csrfField(c)}
              ${field({ label: 'Code aus der App', name: 'code', required: true, error, inputClass: 'input--code', attributes: { inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxlength: 7 } })}
              <button type="submit" class="btn btn--primary">Aktivieren</button>
            </form></li>
        </ol>`,
    });
  }
  return page(c, {
    title: 'Zwei-Faktor-Schutz',
    active: 'account',
    narrow: true,
    content: html`${pageHeader({ title: 'Zwei-Faktor-Schutz', back: { href: '/konto', label: 'Mein Konto' } })}
      ${error && user.totp_enabled ? alert(error, 'danger', 'circle-alert') : ''}
      <div class="stack">${body}</div>`,
  }, status);
}

accountRoutes.get('/konto/2fa', (c) => twoFactorPage(c));

accountRoutes.post('/konto/2fa/aktivieren', async (c) => {
  const user = getUser(c.get('user').id);
  const codes = confirmTotpEnrollment(user, (await readForm(c)).text('code'));
  if (!codes) return twoFactorPage(c, { error: 'Der Code ist nicht gültig. Bitte den aktuellen Code aus der App eingeben.' }, 422);
  logEvent({ user, action: 'auth.2fa_enabled' });
  return recoveryCodesPage(c, codes, 'Der Zwei-Faktor-Schutz ist jetzt aktiv.');
});

accountRoutes.post('/konto/2fa/codes', async (c) => {
  const user = c.get('user');
  if (!(await confirmPassword(user, (await readForm(c)).text('password'), clientIp(c)))) {
    return twoFactorPage(c, { error: 'Das Passwort stimmt nicht.' }, 422);
  }
  if (!user.totp_enabled) return c.redirect('/konto/2fa', 303);
  return recoveryCodesPage(c, regenerateRecoveryCodes(user.id), 'Neue Codes erzeugt.');
});

accountRoutes.post('/konto/2fa/deaktivieren', async (c) => {
  const user = c.get('user');
  if (!(await confirmPassword(user, (await readForm(c)).text('password'), clientIp(c)))) {
    return twoFactorPage(c, { error: 'Das Passwort stimmt nicht.' }, 422);
  }
  disableTotp(user.id);
  logEvent({ user, action: 'auth.2fa_disabled' });
  return redirect(c, '/konto', 'Zwei-Faktor-Schutz deaktiviert.');
});

// Mobile "Mehr" page: every destination that does not fit into the tab bar.
accountRoutes.get('/mehr', (c) => {
  const user = c.get('user');
  const nav = navigation(c);
  const link = (item) => html`<a class="menu__item" href="${item.href}">${icon(item.icon, { size: 20 })}<span>${item.label}</span>${icon('chevron-right', { size: 16, className: 'menu__chevron' })}</a>`;
  return page(c, {
    title: 'Menü',
    active: 'more',
    narrow: true,
    content: html`${pageHeader({ title: 'Menü' })}
      <div class="stack">
        <div class="menu">${nav.main.map(link)}</div>
        ${nav.admin.length > 0 ? html`<div class="menu"><p class="menu__heading">Verwaltung</p>${nav.admin.map(link)}</div>` : ''}
        <div class="menu">
          <p class="menu__heading">${user.name} · ${ROLE[user.role]}</p>
          ${link({ href: '/konto', label: 'Mein Konto', icon: 'user' })}
          <button type="button" class="menu__item" data-theme-toggle>${icon('sun-moon', { size: 20 })}<span>Hell / Dunkel</span></button>
          <form method="post" action="/logout">${csrfField(c)}<button type="submit" class="menu__item">${icon('log-out', { size: 20 })}<span>Abmelden</span></button></form>
        </div>
      </div>`,
  });
});
