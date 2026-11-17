// User administration (admin only).
import { Hono } from 'hono';
import { html } from 'hono/html';
import { createUser, deleteUser, getUser, listUsers, setPassword, updateUser, validateProfile } from '../../services/users.js';
import { destroyAllSessions, disableTotp, unlockUser } from '../../services/auth.js';
import { logEvent } from '../../services/events.js';
import { temporaryPassword } from '../../lib/security.js';
import { ROLE } from '../../lib/terms.js';
import { formatDateTime } from '../../lib/format.js';
import { page } from '../layout.js';
import { idParam, notFound, readForm, redirect, requireAdmin } from '../http.js';
import { confirmation } from '../confirm.js';
import { icon } from '../icons.js';
import { alert, badge, card, checkbox, csrfField, errorSummary, field, pageHeader, postButton, select } from '../ui.js';

export const userRoutes = new Hono();
userRoutes.use('/nutzer', requireAdmin);
userRoutes.use('/nutzer/*', requireAdmin);

const roleOptions = Object.entries(ROLE).map(([value, label]) => ({ value, label }));
const ROLE_HINT = 'Mitarbeiter sehen Geräte, melden Defekte und tragen Prüfungen ein. Administratoren verwalten zusätzlich Geräte, Stammdaten und Nutzer.';

/** Shows a freshly generated password exactly once. */
function passwordNotice(c, user, password, created) {
  return page(c, {
    title: 'Vorläufiges Passwort',
    active: 'users',
    narrow: true,
    content: html`${pageHeader({ title: created ? 'Nutzer angelegt' : 'Passwort zurückgesetzt', back: { href: '/nutzer', label: 'Nutzer' } })}
      ${card({
        body: html`<p>Gib <strong>${user.name}</strong> diese Zugangsdaten auf sicherem Weg weiter. Beim ersten Anmelden muss ein eigenes Passwort festgelegt werden.</p>
          <dl class="credentials">
            <div><dt>Benutzername</dt><dd class="mono">${user.username}</dd></div>
            <div><dt>Vorläufiges Passwort</dt><dd class="mono" id="temp-password">${password}</dd></div>
          </dl>
          ${alert('Dieses Passwort wird nur jetzt angezeigt und nirgends im Klartext gespeichert.', 'warning', 'key-round')}
          <div class="form-actions">
            <button type="button" class="btn" data-copy="#temp-password">${icon('copy', { size: 16 })}Passwort kopieren</button>
            <a class="btn btn--primary" href="/nutzer">Fertig</a>
          </div>`,
      })}`,
  });
}

function userForm(c, { user = null, values, errors = {} }, status = 200) {
  const editing = Boolean(user);
  const self = editing && user.id === c.get('user').id;
  const content = html`${pageHeader({ title: editing ? user.name : 'Nutzer hinzufügen', subtitle: editing ? user.username : '', back: { href: '/nutzer', label: 'Nutzer' } })}
    <div class="stack">
      <form method="post" action="${editing ? `/nutzer/${user.id}` : '/nutzer'}" class="card form form--page">
        ${csrfField(c)}
        ${errorSummary(errors)}
        ${field({ label: 'Name', name: 'name', value: values.name, required: true, error: errors.name, attributes: { maxlength: 80, autofocus: !editing } })}
        ${field({ label: 'Benutzername', name: 'username', value: values.username, required: true, error: errors.username, hint: 'Zum Anmelden – z. B. die E-Mail-Adresse.', attributes: { maxlength: 64, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off' } })}
        ${select({ label: 'Rolle', name: 'role', value: values.role ?? 'member', options: roleOptions, hint: ROLE_HINT })}
        ${editing ? checkbox({ label: 'Konto aktiv', name: 'active', checked: Boolean(values.active), hint: 'Deaktivierte Nutzer können sich nicht mehr anmelden; ihre Einträge bleiben erhalten.' }) : alert('Nach dem Anlegen wird ein vorläufiges Passwort angezeigt.', 'info', 'info')}
        <div class="form-actions">
          <a class="btn" href="/nutzer">Abbrechen</a>
          <button type="submit" class="btn btn--primary">${editing ? 'Speichern' : 'Nutzer anlegen'}</button>
        </div>
      </form>
      ${editing
        ? card({
            title: 'Zugang',
            body: html`<div class="button-row">
              ${postButton(c, { action: `/nutzer/${user.id}/passwort`, label: 'Passwort zurücksetzen', iconName: 'key-round', confirm: `Für ${user.name} ein neues vorläufiges Passwort erzeugen? Alle Geräte werden abgemeldet.` })}
              ${user.totp_enabled ? postButton(c, { action: `/nutzer/${user.id}/2fa`, label: 'Zwei-Faktor-Schutz zurücksetzen', iconName: 'shield', confirm: `Zwei-Faktor-Schutz von ${user.name} entfernen? (z. B. bei verlorenem Handy)` }) : ''}
              ${self ? '' : postButton(c, { action: `/nutzer/${user.id}/loeschen`, label: 'Nutzer löschen', iconName: 'trash-2', className: 'btn btn--danger', confirm: `${user.name} endgültig löschen? Von ihm erfasste Einträge bleiben mit Namen erhalten.` })}
            </div>`,
          })
        : ''}
    </div>`;
  return page(c, { title: editing ? user.name : 'Nutzer hinzufügen', active: 'users', narrow: true, content }, status);
}

userRoutes.get('/nutzer', (c) => {
  const users = listUsers();
  const content = html`${pageHeader({
      title: 'Nutzer',
      subtitle: 'Wer darf sich anmelden – und mit welchen Rechten',
      actions: html`<a class="btn btn--primary" href="/nutzer/neu">${icon('user-plus', { size: 16 })}Nutzer hinzufügen</a>`,
    })}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Rolle</th><th class="hide-sm">2FA</th><th class="hide-md">Letzte Anmeldung</th><th></th></tr></thead>
      <tbody>
        ${users.map(
          (user) => html`<tr class="${user.active ? '' : 'row--muted'}">
            <td class="table__primary"><a href="/nutzer/${user.id}">${user.name}</a><span class="cell-sub">${user.username}</span></td>
            <td>${badge(ROLE[user.role], user.role === 'admin' ? 'info' : 'neutral')}${user.active ? '' : badge('Deaktiviert', 'muted')}${user.must_change_password ? badge('Vorläufiges Passwort', 'warning') : ''}</td>
            <td class="hide-sm">${user.totp_enabled ? badge('Aktiv', 'success') : html`<span class="muted">–</span>`}</td>
            <td class="hide-md nowrap">${user.last_login_at ? formatDateTime(user.last_login_at) : html`<span class="muted">noch nie</span>`}</td>
            <td class="table__actions"><a class="btn btn--sm" href="/nutzer/${user.id}">Bearbeiten</a></td>
          </tr>`,
        )}
      </tbody>
    </table></div>
    <p class="muted small">${ROLE_HINT}</p>`;
  return page(c, { title: 'Nutzer', active: 'users', content });
});

userRoutes.get('/nutzer/neu', (c) => userForm(c, { values: { role: 'member' } }));

userRoutes.post('/nutzer', async (c) => {
  const input = (await readForm(c)).values();
  const { values, errors } = validateProfile(input);
  if (Object.keys(errors).length > 0) return userForm(c, { values: input, errors }, 422);
  const password = temporaryPassword();
  const user = await createUser({ ...values, password, mustChangePassword: true });
  logEvent({ user: c.get('user'), action: 'user.created', detail: `${user.name} (${ROLE[user.role]})` });
  return passwordNotice(c, user, password, true);
});

function loadUser(c) {
  const user = getUser(idParam(c));
  if (!user) throw notFound('Diesen Nutzer gibt es nicht (mehr).');
  return user;
}

userRoutes.get('/nutzer/:id{[0-9]+}', (c) => {
  const user = loadUser(c);
  return userForm(c, { user, values: user });
});

userRoutes.post('/nutzer/:id{[0-9]+}', async (c) => {
  const user = loadUser(c);
  const form = await readForm(c);
  const input = { ...form.values(), active: form.has('active') };
  const { values, errors } = validateProfile(input, { ignoreId: user.id });
  if (Object.keys(errors).length === 0) {
    const problem = updateUser(user.id, { ...values, active: input.active });
    if (problem) errors.role = problem;
  }
  if (Object.keys(errors).length > 0) return userForm(c, { user, values: input, errors }, 422);
  logEvent({ user: c.get('user'), action: 'user.updated', detail: values.name });
  return redirect(c, '/nutzer', `${values.name} gespeichert.`);
});

userRoutes.post('/nutzer/:id{[0-9]+}/passwort', async (c) => {
  const user = loadUser(c);
  const pending = await confirmation(c, { title: 'Passwort zurücksetzen', message: `Für ${user.name} ein neues vorläufiges Passwort erzeugen?`, label: 'Zurücksetzen', cancel: `/nutzer/${user.id}` });
  if (pending) return pending;
  const password = temporaryPassword();
  await setPassword(user.id, password, { mustChangePassword: true });
  // The admin's own session must survive resetting their own password.
  if (user.id !== c.get('user').id) destroyAllSessions(user.id);
  unlockUser(user.username);
  logEvent({ user: c.get('user'), action: 'user.password_reset', detail: user.name });
  return passwordNotice(c, user, password, false);
});

userRoutes.post('/nutzer/:id{[0-9]+}/2fa', async (c) => {
  const user = loadUser(c);
  const pending = await confirmation(c, { title: 'Zwei-Faktor-Schutz zurücksetzen', message: `Zwei-Faktor-Schutz von ${user.name} entfernen?`, label: 'Zurücksetzen', cancel: `/nutzer/${user.id}` });
  if (pending) return pending;
  disableTotp(user.id);
  logEvent({ user: c.get('user'), action: 'user.2fa_reset', detail: user.name });
  return redirect(c, `/nutzer/${user.id}`, 'Zwei-Faktor-Schutz entfernt.');
});

userRoutes.post('/nutzer/:id{[0-9]+}/loeschen', async (c) => {
  const user = loadUser(c);
  if (user.id === c.get('user').id) return redirect(c, `/nutzer/${user.id}`, 'Das eigene Konto kann nicht gelöscht werden.', 'error');
  const pending = await confirmation(c, { title: 'Nutzer löschen', message: `${user.name} endgültig löschen?`, cancel: `/nutzer/${user.id}` });
  if (pending) return pending;
  const problem = deleteUser(user.id);
  if (problem) return redirect(c, `/nutzer/${user.id}`, problem, 'error');
  logEvent({ user: c.get('user'), action: 'user.deleted', detail: user.name });
  return redirect(c, '/nutzer', `${user.name} wurde gelöscht.`);
});
