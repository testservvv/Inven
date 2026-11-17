// Small helpers shared by all route handlers.
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../config.js';
import { setFlash } from '../services/auth.js';
import { chosenFiles } from '../lib/uploads.js';

/** Address of the browser, honouring X-Forwarded-For only for the configured number of proxies. */
export function clientIp(c) {
  let remote = 'unknown';
  try {
    remote = getConnInfo(c).remote.address || 'unknown';
  } catch {
    // No socket (e.g. requests made directly against the app in tests).
  }
  let ip = remote;
  if (config.trustProxy > 0) {
    const chain = (c.req.header('x-forwarded-for') || '').split(',').map((part) => part.trim()).filter(Boolean);
    chain.push(remote);
    ip = chain[Math.max(0, chain.length - 1 - config.trustProxy)];
  }
  return ip.replace(/^::ffff:/, '').slice(0, 64);
}

/** Public origin of the app ("https://inventar.example.de") for links in QR codes. */
export function publicOrigin(c) {
  if (config.appUrl) return config.appUrl;
  const forwarded = config.trustProxy > 0;
  const protocol = (forwarded && c.req.header('x-forwarded-proto')?.split(',')[0].trim()) || new URL(c.req.url).protocol.replace(':', '');
  const host = (forwarded && c.req.header('x-forwarded-host')?.split(',')[0].trim()) || c.req.header('host') || new URL(c.req.url).host;
  return `${protocol === 'https' ? 'https' : 'http'}://${host}`;
}

/** Thin wrapper around FormData with the conversions the handlers need. */
export class Form {
  constructor(data) {
    this.data = data;
  }

  /** Single text value ('' when missing or when the field is a file). */
  text(name) {
    const value = this.data.get(name);
    return typeof value === 'string' ? value : '';
  }

  /** All text values of a repeated field (checkbox groups). */
  list(name) {
    return this.data.getAll(name).filter((value) => typeof value === 'string');
  }

  has(name) {
    return this.data.has(name);
  }

  files(name) {
    return chosenFiles(this.data.getAll(name));
  }

  /** Plain object of all text fields (first value wins). */
  values() {
    const out = {};
    for (const [key, value] of this.data.entries()) {
      if (typeof value === 'string' && !(key in out)) out[key] = value;
    }
    return out;
  }
}

/** Parsed request body. Parsed once per request; later calls return the same object. */
export async function readForm(c) {
  let form = c.get('form');
  if (!form) {
    let data;
    try {
      data = await c.req.formData();
    } catch {
      data = new FormData();
    }
    form = new Form(data);
    c.set('form', form);
  }
  return form;
}

/** POST → redirect → GET, optionally with a one-time message for the next page. */
export function redirect(c, location, message, type = 'success') {
  if (message && c.get('session')) setFlash(c.get('session').id, message, type);
  return c.redirect(location, 303);
}

export const notFound = (message = 'Diese Seite gibt es nicht (mehr).') => new HTTPException(404, { message });
export const forbidden = (message = 'Dafür fehlt die Berechtigung.') => new HTTPException(403, { message });

/** Positive integer route parameter, otherwise 404. */
export function idParam(c, name = 'id') {
  const raw = c.req.param(name) ?? '';
  if (!/^\d{1,12}$/.test(raw)) throw notFound();
  return Number(raw);
}

export function pageParam(c) {
  const page = Number.parseInt(c.req.query('seite') ?? '1', 10);
  return Number.isInteger(page) && page >= 1 && page <= 100000 ? page : 1;
}

/** Only allow redirects to paths of this app (never to other sites). */
export function safeNext(value, fallback = '/') {
  const target = String(value ?? '');
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || /[\u0000-\u001f]/.test(target)) {
    return fallback;
  }
  return target;
}

export function requireAdmin(c, next) {
  if (c.get('user')?.role !== 'admin') throw forbidden('Dieser Bereich ist Administratoren vorbehalten.');
  return next();
}

export const isAdmin = (c) => c.get('user')?.role === 'admin';

/** Current path + query with some parameters changed (null removes one). */
export function withQuery(c, changes) {
  const url = new URL(c.req.url);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  const query = url.searchParams.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}
