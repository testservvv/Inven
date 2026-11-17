// Page shells: the application layout with navigation, and the bare layout
// used for login, setup and error pages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { html, raw } from 'hono/html';
import { getCookie } from 'hono/cookie';
import { config } from '../config.js';
import { takeFlash } from '../services/auth.js';
import { companyName } from '../services/settings.js';
import { defectCounts } from '../services/defects.js';
import { planCounts } from '../services/inspections.js';
import { ROLE } from '../lib/terms.js';
import { icon } from './icons.js';
import { csrfField } from './ui.js';

// Static files are cached "forever" by browsers; this fingerprint changes the
// URL whenever a stylesheet or script changes.
function fingerprint() {
  const hash = crypto.createHash('sha1');
  for (const file of ['css/app.css', 'js/app.js', 'js/scanner.js']) {
    try {
      hash.update(fs.readFileSync(path.join(config.publicDir, file)));
    } catch {
      // A missing file simply does not contribute.
    }
  }
  return hash.digest('hex').slice(0, 10);
}
const version = fingerprint();
export const asset = (file) => `/static/${file}?v=${version}`;

const NAV = [
  { href: '/', label: 'Übersicht', icon: 'layout-dashboard', key: 'dashboard' },
  { href: '/inventar', label: 'Inventar', icon: 'package', key: 'assets' },
  { href: '/defekte', label: 'Defekte', icon: 'triangle-alert', key: 'defects', badge: 'defects' },
  { href: '/pruefungen', label: 'Prüfungen', icon: 'clipboard-check', key: 'inspections', badge: 'inspections' },
  { href: '/scannen', label: 'Scannen', icon: 'scan-qr-code', key: 'scan' },
];

const ADMIN_NAV = [
  { href: '/etiketten', label: 'QR-Etiketten', icon: 'qr-code', key: 'labels' },
  { href: '/stammdaten', label: 'Stammdaten', icon: 'sliders-horizontal', key: 'masterdata' },
  { href: '/daten', label: 'Import & Export', icon: 'file-spreadsheet', key: 'data' },
  { href: '/nutzer', label: 'Nutzer', icon: 'users', key: 'users' },
  { href: '/aktivitaet', label: 'Aktivität', icon: 'activity', key: 'activity' },
  { href: '/einstellungen', label: 'Einstellungen', icon: 'settings', key: 'settings' },
];

export function navigation(c) {
  const admin = c.get('user')?.role === 'admin';
  return { main: NAV, admin: admin ? ADMIN_NAV : [] };
}

function theme(c) {
  const value = getCookie(c, 'theme');
  return value === 'dark' || value === 'light' ? value : 'auto';
}

function head(c, title) {
  const company = companyName();
  return html`<meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0c0c0e" media="(prefers-color-scheme: dark)" />
    <title>${title} · ${company || 'Inventar'}</title>
    <link rel="icon" href="/static/icon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/static/icon-180.png" />
    <link rel="manifest" href="/static/manifest.webmanifest" />
    <link rel="stylesheet" href="${asset('css/app.css')}" />
    <script src="${asset('js/app.js')}" defer></script>`;
}

function brand() {
  return html`<span class="brand__mark">${icon('package', { size: 18 })}</span>
    <span class="brand__name">${companyName() || 'Inventar'}</span>`;
}

function toast(flash) {
  if (!flash) return '';
  const error = flash.type === 'error';
  return html`<div class="toast${error ? ' toast--error' : ''}" role="${error ? 'alert' : 'status'}" data-toast>
    ${icon(error ? 'circle-alert' : 'circle-check')}
    <span>${flash.text}</span>
    <button type="button" class="toast__close" aria-label="Meldung schließen" data-toast-close>${icon('x', { size: 16 })}</button>
  </div>`;
}

function navLink(item, active, counts) {
  const count = item.badge ? counts[item.badge] : 0;
  return html`<a class="nav__link${item.key === active ? ' nav__link--active' : ''}" href="${item.href}"${item.key === active ? raw(' aria-current="page"') : ''}>
    ${icon(item.icon)}<span>${item.label}</span>
    ${count > 0 ? html`<span class="nav__count">${count}</span>` : ''}
  </a>`;
}

/**
 * Renders a full application page.
 * @param {object} options
 * @param {string} options.title   document title
 * @param {string} [options.active] key of the highlighted navigation entry
 * @param {unknown} options.content page body (html``)
 * @param {boolean} [options.narrow] centre the content in a narrow column (forms)
 * @param {string[]} [options.scripts] extra scripts from /static/js
 */
export function page(c, { title, active = '', content, narrow = false, scripts = [] }, status = 200) {
  const user = c.get('user');
  const nav = navigation(c);
  // Navigation badges show what needs attention right now.
  const plans = planCounts();
  const counts = { defects: defectCounts().open, inspections: plans.failed + plans.overdue };
  const flash = takeFlash(c.get('session'));
  const tabItems = [NAV[0], NAV[1], NAV[4], NAV[2], NAV[3]];

  return c.html(
    html`<!doctype html>
<html lang="de" data-theme="${theme(c)}">
  <head>
    ${head(c, title)}
    ${scripts.map((file) => html`<script src="${asset(`js/${file}`)}" defer></script>`)}
  </head>
  <body>
    <a class="skip-link" href="#inhalt">Zum Inhalt springen</a>
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="/">${brand()}</a>
        <nav class="nav" aria-label="Hauptnavigation">
          ${nav.main.map((item) => navLink(item, active, counts))}
          ${nav.admin.length > 0 ? html`<p class="nav__heading">Verwaltung</p>${nav.admin.map((item) => navLink(item, active, counts))}` : ''}
        </nav>
        <div class="sidebar__footer">
          <a class="account${active === 'account' ? ' account--active' : ''}" href="/konto">
            <span class="account__avatar" aria-hidden="true">${initials(user.name)}</span>
            <span class="account__text"><span class="account__name">${user.name}</span><span class="account__role">${ROLE[user.role]}</span></span>
          </a>
          <div class="sidebar__tools">
            <button type="button" class="icon-btn" data-theme-toggle aria-label="Farbschema wechseln" title="Hell / Dunkel">${icon('sun-moon')}</button>
            <form method="post" action="/logout" class="inline-form">
              ${csrfField(c)}
              <button type="submit" class="icon-btn" aria-label="Abmelden" title="Abmelden">${icon('log-out')}</button>
            </form>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <a class="brand" href="/">${brand()}</a>
          <a class="icon-btn${active === 'more' ? ' icon-btn--active' : ''}" href="/mehr" aria-label="Menü">${icon('menu', { size: 22 })}</a>
        </header>
        <main id="inhalt" class="content${narrow ? ' content--narrow' : ''}" tabindex="-1">${content}</main>
      </div>
    </div>
    <nav class="tabbar" aria-label="Schnellnavigation">
      ${tabItems.map(
        (item) => html`<a class="tabbar__item${item.key === active ? ' tabbar__item--active' : ''}${item.key === 'scan' ? ' tabbar__item--scan' : ''}" href="${item.href}">
          <span class="tabbar__icon">${icon(item.icon, { size: 22 })}${item.badge && counts[item.badge] > 0 ? html`<span class="tabbar__dot"></span>` : ''}</span>
          <span class="tabbar__label">${item.label}</span>
        </a>`,
      )}
    </nav>
    ${toast(flash)}
  </body>
</html>`,
    status,
  );
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/** Layout without navigation for login, setup and error pages. */
export function barePage(c, { title, content, wide = false }, status = 200) {
  return c.html(
    html`<!doctype html>
<html lang="de" data-theme="${theme(c)}">
  <head>
    ${head(c, title)}
  </head>
  <body class="bare">
    <main class="bare__main${wide ? ' bare__main--wide' : ''}">
      <div class="brand brand--center">${brand()}</div>
      ${content}
    </main>
  </body>
</html>`,
    status,
  );
}

const ERROR_TITLES = {
  400: 'Ungültige Anfrage',
  403: 'Kein Zugriff',
  404: 'Nicht gefunden',
  413: 'Datei zu groß',
  429: 'Zu viele Versuche',
  500: 'Da ist etwas schiefgelaufen',
};

export function errorPage(c, status, message) {
  const title = ERROR_TITLES[status] ?? 'Fehler';
  const content = html`<div class="error-page">
    <p class="error-page__code">${status}</p>
    <h1>${title}</h1>
    <p class="muted">${message}</p>
    <p><a class="btn btn--primary" href="/">Zur Übersicht</a></p>
  </div>`;
  // Inside the app (logged in) the navigation stays available.
  if (c.get('user') && !c.get('user').must_change_password) {
    try {
      return page(c, { title, content }, status);
    } catch {
      // Fall through to the bare layout if even the shell cannot be rendered.
    }
  }
  return barePage(c, { title, content }, status);
}
