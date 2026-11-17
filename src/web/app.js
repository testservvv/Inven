// Assembles the web application: security middleware first, then the public
// login routes, then everything that requires a signed-in user.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '../config.js';
import { get } from '../db.js';
import { loadSession } from '../services/auth.js';
import { countUsers } from '../services/users.js';
import { safeEqual } from '../lib/security.js';
import { errorPage } from './layout.js';
import { readForm } from './http.js';
import { SESSION_COOKIE, authRoutes, setSessionCookie } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { assetRoutes } from './routes/assets.js';
import { defectRoutes } from './routes/defects.js';
import { inspectionRoutes } from './routes/inspections.js';
import { scanRoutes } from './routes/scan.js';
import { fileRoutes } from './routes/files.js';
import { labelRoutes } from './routes/labels.js';
import { masterdataRoutes } from './routes/masterdata.js';
import { dataRoutes } from './routes/data.js';
import { userRoutes } from './routes/users.js';
import { adminRoutes } from './routes/admin.js';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const DEFAULT_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Pages contain business data: never store them in shared or disk caches.
  'Cache-Control': 'no-store',
  ...(config.secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cross-site request check for state-changing requests. Browsers always send
 * an Origin header with cross-site POSTs; it must match this app. Requests
 * without the header (old browsers, command-line tools) are let through here
 * and still need a valid session and CSRF token further down.
 */
function sameOrigin(c) {
  const origin = c.req.header('origin');
  if (!origin) return c.req.header('sec-fetch-site') !== 'cross-site';
  if (config.appUrl && origin === config.appUrl) return true;
  try {
    const host = new URL(origin).host;
    const forwarded = config.trustProxy > 0 ? c.req.header('x-forwarded-host')?.split(',')[0].trim() : null;
    return host === new URL(c.req.url).host || host === forwarded;
  } catch {
    return false;
  }
}

export function createApp() {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      const message = error.message && error.message !== 'Payload Too Large' ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.';
      return errorPage(c, error.status, error.status === 413 ? 'Die hochgeladenen Daten sind zu groß.' : message);
    }
    console.error(`[Fehler] ${c.req.method} ${c.req.path}`, error);
    return errorPage(c, 500, 'Ein unerwarteter Fehler ist aufgetreten. Bitte erneut versuchen.');
  });

  app.notFound((c) => errorPage(c, 404, 'Diese Seite gibt es nicht (mehr).'));

  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!c.res.headers.has(name)) c.header(name, value);
    }
  });

  app.use(
    '/static/*',
    serveStatic({
      root: config.publicDir,
      rewriteRequestPath: (path) => path.replace(/^\/static/, ''),
      onFound: (_path, c) => {
        // Fingerprinted files (?v=…) never change; everything else may be cached briefly.
        c.header('Cache-Control', c.req.query('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    }),
  );
  app.get('/static/*', (c) => c.text('Nicht gefunden', 404));

  app.get('/healthz', (c) => {
    get('SELECT 1 AS ok');
    return c.text('ok');
  });
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

  // Session lookup. A sliding session also refreshes its cookie.
  app.use('*', async (c, next) => {
    const loaded = loadSession(getCookie(c, SESSION_COOKIE));
    if (loaded) {
      c.set('session', loaded.session);
      c.set('user', loaded.user);
      if (loaded.session.refreshed && loaded.session.persistent) {
        setSessionCookie(c, getCookie(c, SESSION_COOKIE), true);
      }
    }
    return next();
  });

  // Uploads arrive as multipart forms; everything else is a small text form.
  // Only signed-in users may send large bodies, so strangers cannot make the
  // server buffer big requests.
  const uploadLimit = bodyLimit({ maxSize: config.maxUploadBytes * 3 + 1024 * 1024 });
  const formLimit = bodyLimit({ maxSize: 1024 * 1024 });
  app.use('*', (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) return next();
    if (!sameOrigin(c)) {
      throw new HTTPException(403, {
        message: 'Die Anfrage kam nicht von dieser Anwendung und wurde abgelehnt. Falls das unerwartet ist: In der Server-Konfiguration muss APP_URL der Adresse entsprechen, unter der die Anwendung aufgerufen wird.',
      });
    }
    const multipart = (c.req.header('content-type') || '').startsWith('multipart/form-data');
    return (multipart && c.get('user') ? uploadLimit : formLimit)(c, next);
  });

  // A fresh installation has no accounts yet: everything leads to the setup page.
  let installed = false;
  app.use('*', (c, next) => {
    installed ||= countUsers() > 0;
    if (!installed && c.req.path !== '/setup') return c.redirect('/setup', 302);
    return next();
  });

  app.route('/', authRoutes);

  // --- Everything below requires a signed-in user ---------------------------
  app.use('*', async (c, next) => {
    const user = c.get('user');
    if (!user) {
      if (c.req.method === 'GET') {
        const target = c.req.path + (new URL(c.req.url).search || '');
        return c.redirect(target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`, 302);
      }
      throw new HTTPException(403, { message: 'Die Sitzung ist abgelaufen. Bitte erneut anmelden.' });
    }
    if (UNSAFE_METHODS.has(c.req.method)) {
      const form = await readForm(c);
      const token = form.text('_csrf') || c.req.header('x-csrf-token') || '';
      if (!safeEqual(token, c.get('session').csrf_token)) {
        throw new HTTPException(403, {
          message: 'Das Formular ist abgelaufen. Bitte die vorherige Seite neu laden und erneut absenden.',
        });
      }
    }
    // Accounts with a temporary password may only set a new one (or sign out).
    if (user.must_change_password && !['/konto/passwort', '/logout'].includes(c.req.path)) {
      return c.redirect('/konto/passwort', 302);
    }
    return next();
  });

  for (const routes of [
    accountRoutes,
    dashboardRoutes,
    assetRoutes,
    defectRoutes,
    inspectionRoutes,
    scanRoutes,
    fileRoutes,
    labelRoutes,
    masterdataRoutes,
    dataRoutes,
    userRoutes,
    adminRoutes,
  ]) {
    app.route('/', routes);
  }

  return app;
}
