// Reusable HTML building blocks. Everything is rendered on the server with
// hono's `html` tag, which escapes all interpolated values by default.
import { html, raw } from 'hono/html';
import { icon } from './icons.js';
import { withQuery } from './http.js';
import { ASSET_STATUS, DEFECT_STATUS, PLAN_STATE, RESULT, SEVERITY } from '../lib/terms.js';
import { formatDate, relativeDays } from '../lib/format.js';

const escapeAttribute = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Renders an attribute map; false/null/undefined are skipped, true becomes a bare attribute. */
export function attrs(map = {}) {
  let out = '';
  for (const [name, value] of Object.entries(map)) {
    if (value === false || value === null || value === undefined) continue;
    out += value === true ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
  }
  return raw(out);
}

export const csrfField = (c) => html`<input type="hidden" name="_csrf" value="${c.get('session')?.csrf_token ?? ''}" />`;

// --- Badges -----------------------------------------------------------------
export function badge(text, tone = 'neutral') {
  return html`<span class="badge badge--${tone}"><span class="badge__dot"></span>${text}</span>`;
}

const PLAN_TONE = { failed: 'danger', overdue: 'danger', open: 'warning', soon: 'warning', ok: 'success' };
export const planBadge = (state) => badge(PLAN_STATE[state], PLAN_TONE[state]);

const SEVERITY_TONE = { critical: 'danger', medium: 'warning', low: 'neutral' };
export const severityBadge = (severity) => badge(SEVERITY[severity], SEVERITY_TONE[severity]);

const DEFECT_TONE = { open: 'danger', in_progress: 'info', resolved: 'success' };
export const defectStatusBadge = (status) => badge(DEFECT_STATUS[status], DEFECT_TONE[status]);

const RESULT_TONE = { passed: 'success', remarks: 'warning', failed: 'danger' };
export const resultBadge = (result) => badge(RESULT[result], RESULT_TONE[result]);

const ASSET_TONE = { active: 'success', storage: 'neutral', repair: 'warning', retired: 'muted', lost: 'danger' };
export const assetStatusBadge = (status) => badge(ASSET_STATUS[status], ASSET_TONE[status]);

const PLAN_RANK_STATE = [null, 'ok', 'soon', 'open', 'overdue', 'failed'];

/** Compact health summary of a device row: open defects and inspection state. */
export function conditionBadges(asset) {
  const parts = [];
  if (asset.open_defects > 0) {
    const tone = asset.defect_rank === 3 ? 'danger' : asset.defect_rank === 2 ? 'warning' : 'neutral';
    parts.push(badge(asset.open_defects === 1 ? '1 Defekt' : `${asset.open_defects} Defekte`, tone));
  }
  const state = PLAN_RANK_STATE[asset.plan_rank ?? 0];
  if (state && state !== 'ok') parts.push(badge(state === 'soon' ? 'Prüfung bald fällig' : state === 'open' ? 'Prüftermin offen' : state === 'overdue' ? 'Prüfung überfällig' : 'Prüfung nicht bestanden', PLAN_TONE[state]));
  if (parts.length === 0) return badge('In Ordnung', 'success');
  return parts;
}

/** "12.03.2027 · in 116 Tagen" */
export function dueText(date) {
  if (!date) return html`<span class="muted">kein Termin</span>`;
  return html`${formatDate(date)} <span class="muted">· ${relativeDays(date)}</span>`;
}

// --- Form controls ----------------------------------------------------------
/** Element id of a control; pass `id` when a field name occurs more than once on a page. */
const fieldId = (options) => options.id ?? `f-${options.name}`;

function wrapField(options, control) {
  const { label, name, error, hint, required, className = '' } = options;
  return html`<div class="field ${className}${error ? ' field--error' : ''}">
    <label class="field__label" for="${fieldId(options)}">${label}${required ? html`<span class="field__required" aria-hidden="true"> *</span>` : ''}</label>
    ${control}
    ${error ? html`<p class="field__error" id="e-${name}">${error}</p>` : ''}
    ${hint && !error ? html`<p class="field__hint">${hint}</p>` : ''}
  </div>`;
}

export function field(options) {
  const { name, value = '', type = 'text', required = false, error, attributes = {}, inputClass = '' } = options;
  return wrapField(
    options,
    html`<input class="input${inputClass ? ` ${inputClass}` : ''}" id="${fieldId(options)}" name="${name}" type="${type}" value="${value ?? ''}"${attrs({
      required,
      'aria-invalid': error ? 'true' : null,
      'aria-describedby': error ? `e-${name}` : null,
      ...attributes,
    })} />`,
  );
}

export function textarea(options) {
  const { name, value = '', rows = 3, required = false, error, attributes = {} } = options;
  return wrapField(
    options,
    html`<textarea class="input" id="${fieldId(options)}" name="${name}" rows="${rows}"${attrs({
      required,
      'aria-invalid': error ? 'true' : null,
      ...attributes,
    })}>${value ?? ''}</textarea>`,
  );
}

/**
 * options.options: [{ value, label }]; options.placeholder adds an empty first entry.
 * options.createName: adds "＋ Neu anlegen …" plus a text field with that name,
 * so a category or location can be created right from the form.
 */
export function select(options) {
  const { name, value = '', required = false, error, placeholder, createName, createValue = '', createLabel = 'Neu anlegen', attributes = {} } = options;
  const current = String(value ?? '');
  const creating = Boolean(createName && createValue);
  const control = html`<select class="input" id="${fieldId(options)}" name="${name}"${attrs({ required, 'data-create-toggle': createName ? `f-${createName}` : null, ...attributes })}>
      ${placeholder !== undefined ? html`<option value="">${placeholder}</option>` : ''}
      ${options.options.map((option) => html`<option value="${option.value}"${attrs({ selected: !creating && String(option.value) === current })}>${option.label}</option>`)}
      ${createName ? html`<option value="__new"${attrs({ selected: creating })}>＋ ${createLabel} …</option>` : ''}
    </select>
    ${createName
      ? html`<input class="input field__create" id="f-${createName}" name="${createName}" type="text" value="${createValue}" maxlength="80" placeholder="Name für „${createLabel}“" aria-label="${createLabel}" />`
      : ''}`;
  return wrapField(options, control);
}

export function checkbox({ label, name, checked = false, value = '1', hint, attributes = {} }) {
  return html`<label class="check">
    <input type="checkbox" name="${name}" value="${value}"${attrs({ checked, ...attributes })} />
    <span class="check__text">${label}${hint ? html`<span class="check__hint">${hint}</span>` : ''}</span>
  </label>`;
}

/** Radio cards, e.g. severity or inspection result. choices: [{ value, label, hint, tone }] */
export function choiceGroup({ label, name, value, choices, error, required = false }) {
  return html`<fieldset class="field${error ? ' field--error' : ''}">
    <legend class="field__label">${label}${required ? html`<span class="field__required" aria-hidden="true"> *</span>` : ''}</legend>
    <div class="choices">
      ${choices.map(
        (choice) => html`<label class="choice choice--${choice.tone ?? 'neutral'}">
          <input type="radio" name="${name}" value="${choice.value}"${attrs({ checked: choice.value === value, required })} />
          <span class="choice__body"><span class="choice__label">${choice.label}</span>${choice.hint ? html`<span class="choice__hint">${choice.hint}</span>` : ''}</span>
        </label>`,
      )}
    </div>
    ${error ? html`<p class="field__error">${error}</p>` : ''}
  </fieldset>`;
}

/** File picker. `resize` lets the browser shrink large photos before uploading. */
export function fileField({ label, name, id, hint, accept = 'image/*,application/pdf', multiple = true, resize = true, error }) {
  return wrapField(
    { label, name, id, hint, error },
    html`<input class="input input--file" id="${id ?? `f-${name}`}" name="${name}" type="file"${attrs({ accept, multiple, 'data-resize': resize })} />`,
  );
}

export function errorSummary(errors) {
  const messages = Object.values(errors ?? {}).filter(Boolean);
  if (messages.length === 0) return '';
  return html`<div class="alert alert--danger" role="alert">
    ${icon('circle-alert')}
    <div>${messages.length === 1 ? messages[0] : html`Bitte die markierten Felder prüfen.`}</div>
  </div>`;
}

export function alert(content, tone = 'info', iconName = 'info') {
  return html`<div class="alert alert--${tone}">${icon(iconName)}<div>${content}</div></div>`;
}

// --- Page structure ---------------------------------------------------------
export function pageHeader({ title, subtitle = '', back = null, actions = '', badges = '' }) {
  return html`<header class="page-header">
    ${back ? html`<a class="page-header__back" href="${back.href}">${icon('arrow-left', { size: 16 })}${back.label}</a>` : ''}
    <div class="page-header__row">
      <div class="page-header__titles">
        <h1>${title}</h1>
        ${subtitle ? html`<p class="page-header__subtitle">${subtitle}</p>` : ''}
        ${badges ? html`<div class="page-header__badges">${badges}</div>` : ''}
      </div>
      ${actions ? html`<div class="page-header__actions">${actions}</div>` : ''}
    </div>
  </header>`;
}

export function card({ title = '', action = '', body, flush = false, id = null, className = '' }) {
  return html`<section class="card ${className}"${attrs({ id })}>
    ${title || action ? html`<div class="card__header"><h2>${title}</h2>${action ? html`<div class="card__action">${action}</div>` : ''}</div>` : ''}
    <div class="${flush ? 'card__flush' : 'card__body'}">${body}</div>
  </section>`;
}

export function emptyState({ iconName = 'box', title, text = '', action = '' }) {
  return html`<div class="empty">
    <div class="empty__icon">${icon(iconName, { size: 22 })}</div>
    <p class="empty__title">${title}</p>
    ${text ? html`<p class="empty__text">${text}</p>` : ''}
    ${action ? html`<div class="empty__action">${action}</div>` : ''}
  </div>`;
}

/** Definition list from [label, value] pairs; empty values are shown as a dash. */
export function details(pairs) {
  return html`<dl class="details">
    ${pairs
      .filter(Boolean)
      .map(([label, value]) => html`<div class="details__row"><dt>${label}</dt><dd>${value === null || value === undefined || value === '' ? html`<span class="muted">–</span>` : value}</dd></div>`)}
  </dl>`;
}

export function pagination(c, { page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return '';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return html`<nav class="pagination" aria-label="Seiten">
    <span class="pagination__info">${from}–${to} von ${total}</span>
    <div class="pagination__buttons">
      ${page > 1
        ? html`<a class="btn btn--sm" href="${withQuery(c, { seite: page - 1 })}" rel="prev">${icon('chevron-left', { size: 16 })}Zurück</a>`
        : html`<span class="btn btn--sm btn--disabled">${icon('chevron-left', { size: 16 })}Zurück</span>`}
      ${page < pages
        ? html`<a class="btn btn--sm" href="${withQuery(c, { seite: page + 1 })}" rel="next">Weiter${icon('chevron-right', { size: 16 })}</a>`
        : html`<span class="btn btn--sm btn--disabled">Weiter${icon('chevron-right', { size: 16 })}</span>`}
    </div>
  </nav>`;
}

/** Column header that toggles sorting through the query string. */
export function sortHeader(c, key, label, { current, direction, className = '' }) {
  const active = current === key;
  const next = active && direction === 'asc' ? 'desc' : 'asc';
  return html`<th class="${className}"${attrs({ 'aria-sort': active ? (direction === 'asc' ? 'ascending' : 'descending') : null })}>
    <a class="sort${active ? ' sort--active' : ''}" href="${withQuery(c, { sort: key, dir: next, seite: null })}">${label}${active ? icon(direction === 'asc' ? 'arrow-up' : 'arrow-down', { size: 13 }) : ''}</a>
  </th>`;
}

/** Tab-style filter links. items: [{ label, href, active, count }] */
export function tabs(items) {
  return html`<nav class="tabs">
    ${items.map(
      (item) => html`<a class="tabs__item${item.active ? ' tabs__item--active' : ''}" href="${item.href}"${attrs({ 'aria-current': item.active ? 'page' : null })}>
        ${item.label}${item.count !== undefined ? html`<span class="tabs__count">${item.count}</span>` : ''}
      </a>`,
    )}
  </nav>`;
}

/**
 * A button that posts to `action`. Destructive buttons carry a confirmation
 * text: with JavaScript a dialog appears; without it the server shows a
 * confirmation page instead (see `confirmed()` in the routes).
 */
export function postButton(c, { action, label, iconName = null, confirm = null, className = 'btn', fields = {}, title = null }) {
  return html`<form method="post" action="${action}" class="inline-form"${attrs({ 'data-confirm': confirm })}>
    ${csrfField(c)}
    ${Object.entries(fields).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`)}
    <button type="submit" class="${className}"${attrs({ title, 'aria-label': title })}>${iconName ? icon(iconName, { size: 16 }) : ''}${label}</button>
  </form>`;
}
