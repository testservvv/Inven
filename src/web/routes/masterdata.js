// Master data (admin): categories, locations, insurance policies, inspection types.
import { Hono } from 'hono';
import { html } from 'hono/html';
import {
  deleteCategory,
  deleteInspectionType,
  deleteLocation,
  deletePolicy,
  listCategories,
  listInspectionTypes,
  listLocations,
  listPolicies,
  saveCategory,
  saveInspectionType,
  saveLocation,
  savePolicy,
} from '../../services/masterdata.js';
import { logEvent } from '../../services/events.js';
import { formatAmount, formatDate, formatMoney, plural } from '../../lib/format.js';
import { page } from '../layout.js';
import { idParam, readForm, redirect, requireAdmin } from '../http.js';
import { confirmation } from '../confirm.js';
import { icon } from '../icons.js';
import { card, csrfField, field, pageHeader, postButton, textarea } from '../ui.js';

export const masterdataRoutes = new Hono();
masterdataRoutes.use('/stammdaten', requireAdmin);
masterdataRoutes.use('/stammdaten/*', requireAdmin);

/** One editable row: summary line plus a collapsed edit form. */
function row(c, { title, meta = '', editForm, deleteAction, deleteConfirm }) {
  return html`<li class="md-row">
    <details class="md-row__details">
      <summary class="md-row__summary">
        <span class="md-row__title">${title}</span>
        <span class="md-row__meta">${meta}</span>
        <span class="md-row__edit">${icon('pencil', { size: 15 })}<span class="sr-only">Bearbeiten</span></span>
      </summary>
      <div class="md-row__form">
        ${editForm}
        ${postButton(c, { action: deleteAction, label: 'Löschen', iconName: 'trash-2', className: 'link-btn link-btn--danger', confirm: deleteConfirm })}
      </div>
    </details>
  </li>`;
}

function addForm(c, { action, label, fields }) {
  return html`<details class="card__section inline-edit">
    <summary>${icon('plus', { size: 15 })}${label}</summary>
    <form method="post" action="${action}" class="form form--row">${csrfField(c)}${fields}<button type="submit" class="btn btn--sm btn--primary">Anlegen</button></form>
  </details>`;
}

const policyFields = (policy, key) => html`
  ${field({ label: 'Bezeichnung', name: 'name', id: `f-pol-name-${key}`, value: policy.name, required: true, attributes: { maxlength: 80, placeholder: 'z. B. Elektronikversicherung' } })}
  ${field({ label: 'Versicherer', name: 'insurer', id: `f-pol-insurer-${key}`, value: policy.insurer, attributes: { maxlength: 100 } })}
  ${field({ label: 'Versicherungsschein-Nr.', name: 'policy_number', id: `f-pol-number-${key}`, value: policy.policy_number, attributes: { maxlength: 80 } })}
  ${field({ label: 'Versicherungssumme (€)', name: 'sum_insured', id: `f-pol-sum-${key}`, value: formatAmount(policy.sum_insured_cents), attributes: { inputmode: 'decimal', placeholder: '0,00' } })}
  ${field({ label: 'Läuft ab am', name: 'valid_until', id: `f-pol-valid-${key}`, type: 'date', value: policy.valid_until ?? '' })}
  ${field({ label: 'Ansprechpartner / Kontakt', name: 'contact', id: `f-pol-contact-${key}`, value: policy.contact, attributes: { maxlength: 200 } })}
  ${textarea({ label: 'Notiz', name: 'note', id: `f-pol-note-${key}`, value: policy.note, rows: 2, attributes: { maxlength: 500 } })}`;

const typeFields = (type, key) => html`
  ${field({ label: 'Name', name: 'name', id: `f-type-name-${key}`, value: type.name, required: true, attributes: { maxlength: 80 } })}
  ${field({ label: 'Standard-Intervall (Monate)', name: 'default_interval_months', id: `f-type-interval-${key}`, type: 'number', value: type.default_interval_months ?? 12, required: true, attributes: { min: 1, max: 240 } })}
  ${field({ label: 'Beschreibung', name: 'description', id: `f-type-desc-${key}`, value: type.description, attributes: { maxlength: 300 } })}`;

masterdataRoutes.get('/stammdaten', (c) => {
  const categories = listCategories();
  const locations = listLocations();
  const policies = listPolicies();
  const types = listInspectionTypes();
  const usage = (count) => plural(count, 'Gerät', 'Geräte');

  const content = html`${pageHeader({ title: 'Stammdaten', subtitle: 'Auswahllisten für Geräte, Versicherungen und Prüfarten' })}
    <div class="grid-2 grid-2--top">
      ${card({
        title: 'Kategorien',
        id: 'kategorien',
        flush: true,
        body: html`<ul class="md-list">
            ${categories.map((item) =>
              row(c, {
                title: item.name,
                meta: usage(item.asset_count),
                editForm: html`<form method="post" action="/stammdaten/kategorien/${item.id}" class="form form--row">${csrfField(c)}
                  ${field({ label: 'Name', name: 'name', id: `f-cat-${item.id}`, value: item.name, required: true, attributes: { maxlength: 80 } })}
                  <button type="submit" class="btn btn--sm">Speichern</button></form>`,
                deleteAction: `/stammdaten/kategorien/${item.id}/loeschen`,
                deleteConfirm: `Kategorie „${item.name}“ löschen? ${item.asset_count > 0 ? `${usage(item.asset_count)} verlieren ihre Kategorie.` : ''}`,
              }),
            )}
          </ul>
          ${addForm(c, { action: '/stammdaten/kategorien', label: 'Kategorie hinzufügen', fields: field({ label: 'Name', name: 'name', id: 'f-cat-new', required: true, attributes: { maxlength: 80 } }) })}`,
      })}
      ${card({
        title: 'Standorte',
        id: 'standorte',
        flush: true,
        body: html`<ul class="md-list">
            ${locations.map((item) =>
              row(c, {
                title: item.name,
                meta: html`${item.note ? html`${item.note} · ` : ''}${usage(item.asset_count)}`,
                editForm: html`<form method="post" action="/stammdaten/standorte/${item.id}" class="form form--row">${csrfField(c)}
                  ${field({ label: 'Name', name: 'name', id: `f-loc-${item.id}`, value: item.name, required: true, attributes: { maxlength: 80 } })}
                  ${field({ label: 'Hinweis', name: 'note', id: `f-loc-note-${item.id}`, value: item.note, attributes: { maxlength: 200 } })}
                  <button type="submit" class="btn btn--sm">Speichern</button></form>`,
                deleteAction: `/stammdaten/standorte/${item.id}/loeschen`,
                deleteConfirm: `Standort „${item.name}“ löschen? ${item.asset_count > 0 ? `${usage(item.asset_count)} verlieren ihren Standort.` : ''}`,
              }),
            )}
          </ul>
          ${locations.length === 0 ? html`<p class="card__section muted">Noch keine Standorte – z. B. „Büro“, „Lager“, „Werkstatt“.</p>` : ''}
          ${addForm(c, {
            action: '/stammdaten/standorte',
            label: 'Standort hinzufügen',
            fields: html`${field({ label: 'Name', name: 'name', id: 'f-loc-new', required: true, attributes: { maxlength: 80 } })}${field({ label: 'Hinweis', name: 'note', id: 'f-loc-note-new', attributes: { maxlength: 200, placeholder: 'z. B. Adresse' } })}`,
          })}`,
      })}
    </div>
    <div class="stack">
      ${card({
        title: 'Versicherungen',
        id: 'versicherungen',
        flush: true,
        body: html`<ul class="md-list">
            ${policies.map((item) =>
              row(c, {
                title: item.name,
                meta: html`${[item.insurer, item.policy_number].filter(Boolean).join(' · ')}${item.sum_insured_cents !== null ? html` · Summe ${formatMoney(item.sum_insured_cents)}` : ''}${item.valid_until ? html` · bis ${formatDate(item.valid_until)}` : ''} · ${usage(item.asset_count)}`,
                editForm: html`<form method="post" action="/stammdaten/versicherungen/${item.id}" class="form">${csrfField(c)}
                  <div class="form-grid">${policyFields(item, item.id)}</div>
                  <div class="form-actions"><button type="submit" class="btn btn--sm">Speichern</button></div></form>`,
                deleteAction: `/stammdaten/versicherungen/${item.id}/loeschen`,
                deleteConfirm: `Versicherung „${item.name}“ löschen? ${item.asset_count > 0 ? `${usage(item.asset_count)} sind dann keiner Versicherung mehr zugeordnet.` : ''}`,
              }),
            )}
          </ul>
          ${policies.length === 0 ? html`<p class="card__section muted">Lege hier deine Policen an (z. B. Elektronik-, Inhalts- oder Maschinenversicherung) und ordne die Geräte zu. Die Übersicht zeigt dann, ob die Versicherungssumme zum erfassten Wert passt.</p>` : ''}
          <details class="card__section inline-edit">
            <summary>${icon('plus', { size: 15 })}Versicherung hinzufügen</summary>
            <form method="post" action="/stammdaten/versicherungen" class="form">${csrfField(c)}
              <div class="form-grid">${policyFields({}, 'new')}</div>
              <div class="form-actions"><button type="submit" class="btn btn--sm btn--primary">Anlegen</button></div>
            </form>
          </details>`,
      })}
      ${card({
        title: 'Prüfarten',
        id: 'pruefarten',
        flush: true,
        body: html`<ul class="md-list">
            ${types.map((item) =>
              row(c, {
                title: item.name,
                meta: `alle ${item.default_interval_months} Monate · ${usage(item.plan_count)}`,
                editForm: html`<form method="post" action="/stammdaten/pruefarten/${item.id}" class="form form--row">${csrfField(c)}${typeFields(item, item.id)}
                  <button type="submit" class="btn btn--sm">Speichern</button></form>`,
                deleteAction: `/stammdaten/pruefarten/${item.id}/loeschen`,
                deleteConfirm: `Prüfart „${item.name}“ löschen?`,
              }),
            )}
          </ul>
          ${addForm(c, { action: '/stammdaten/pruefarten', label: 'Prüfart hinzufügen', fields: typeFields({}, 'new') })}`,
      })}
    </div>`;
  return page(c, { title: 'Stammdaten', active: 'masterdata', content });
});

/** Registers create / update / delete routes for one kind of master data. */
function crud({ path, anchor, label, save, remove }) {
  const target = `/stammdaten#${anchor}`;
  const handleSave = async (c, id) => {
    const error = save(id, (await readForm(c)).values());
    if (error) return redirect(c, target, error, 'error');
    logEvent({ user: c.get('user'), action: 'masterdata.updated', detail: `${label} gespeichert` });
    return redirect(c, target, `${label} gespeichert.`);
  };
  masterdataRoutes.post(`/stammdaten/${path}`, (c) => handleSave(c, null));
  masterdataRoutes.post(`/stammdaten/${path}/:id{[0-9]+}`, (c) => handleSave(c, idParam(c)));
  masterdataRoutes.post(`/stammdaten/${path}/:id{[0-9]+}/loeschen`, async (c) => {
    const pending = await confirmation(c, { title: `${label} löschen`, message: `${label} wirklich löschen?`, cancel: target });
    if (pending) return pending;
    const error = remove(idParam(c));
    if (typeof error === 'string') return redirect(c, target, error, 'error');
    logEvent({ user: c.get('user'), action: 'masterdata.updated', detail: `${label} gelöscht` });
    return redirect(c, target, `${label} gelöscht.`);
  });
}

crud({ path: 'kategorien', anchor: 'kategorien', label: 'Kategorie', save: saveCategory, remove: deleteCategory });
crud({ path: 'standorte', anchor: 'standorte', label: 'Standort', save: saveLocation, remove: deleteLocation });
crud({ path: 'versicherungen', anchor: 'versicherungen', label: 'Versicherung', save: savePolicy, remove: deletePolicy });
crud({ path: 'pruefarten', anchor: 'pruefarten', label: 'Prüfart', save: saveInspectionType, remove: deleteInspectionType });
