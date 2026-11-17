// Confirmation step for destructive actions.
//
// Forms carry a `data-confirm` text. With JavaScript, app.js shows a dialog
// and adds `_confirmed=1` before submitting. Without JavaScript the request
// arrives unconfirmed and the server answers with this confirmation page,
// which re-posts the original fields. Either way nothing is deleted by a
// single stray click.
import { html } from 'hono/html';
import { page } from './layout.js';
import { readForm } from './http.js';
import { csrfField } from './ui.js';

/** Returns null when the action was confirmed, otherwise the confirmation page response. */
export async function confirmation(c, { title, message, label = 'Löschen', cancel = '/' }) {
  const form = await readForm(c);
  if (form.text('_confirmed') === '1') return null;
  const fields = Object.entries(form.values()).filter(([name]) => name !== '_csrf' && name !== '_confirmed');
  return page(c, {
    title,
    narrow: true,
    content: html`<form method="post" action="${c.req.path}" class="card card--confirm">
      <h1>${title}</h1>
      <p>${message}</p>
      ${csrfField(c)}
      <input type="hidden" name="_confirmed" value="1" />
      ${fields.map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`)}
      <div class="form-actions">
        <a class="btn" href="${cancel}">Abbrechen</a>
        <button type="submit" class="btn btn--danger-solid">${label}</button>
      </div>
    </form>`,
  });
}
