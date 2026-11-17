// Entry point: starts the HTTP server.
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { db } from './db.js';
import { cleanupExpired, setupToken } from './services/auth.js';
import { scheduleSnapshots } from './services/backup.js';
import { createApp } from './web/app.js';

const app = createApp();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const local = `http://localhost:${info.port}`;
  console.log(`Inventar läuft auf ${config.appUrl || local}`);
  if (config.production && !config.secureCookies) {
    console.warn('WARNUNG: APP_URL ist keine https-Adresse. Sitzungs-Cookies werden unverschlüsselt übertragen – nur für Tests geeignet.');
  }
  const token = setupToken();
  if (token) {
    console.log('');
    console.log('Ersteinrichtung: Es gibt noch kein Benutzerkonto. Bitte diese Adresse im Browser öffnen:');
    console.log(`  ${config.appUrl || local}/setup?token=${token}`);
    console.log('');
  }
});

cleanupExpired();
setInterval(cleanupExpired, 3600_000).unref();
scheduleSnapshots();

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not wait forever for keep-alive connections.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
