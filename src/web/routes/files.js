// Authenticated delivery of uploaded photos and documents.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { getAttachmentByToken } from '../../services/attachments.js';
import { isImage, uploadPath } from '../../lib/uploads.js';
import { notFound } from '../http.js';

export const fileRoutes = new Hono();

fileRoutes.get('/dateien/:token/:name?', async (c) => {
  // Members cannot load invoices; the lookup simply does not find them.
  const attachment = getAttachmentByToken(c.req.param('token'), c.get('user'));
  if (!attachment) throw notFound('Diese Datei gibt es nicht (mehr).');
  const file = uploadPath(attachment.token);
  let stats;
  try {
    stats = await fs.promises.stat(file);
  } catch {
    throw notFound('Diese Datei gibt es nicht (mehr).');
  }
  const headers = {
    'Content-Type': attachment.mime,
    'Content-Length': String(stats.size),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    // The content behind a token never changes, so the browser may keep it.
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  // Uploaded content must never be able to run scripts in the app's origin:
  // images are sandboxed. PDFs get no script restrictions of their own because
  // browsers' built-in PDF viewers stop working under a strict policy – a PDF
  // cannot execute scripts in this origin anyway.
  headers['Content-Security-Policy'] = isImage(attachment.mime)
    ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    : "frame-ancestors 'self'";
  return c.body(Readable.toWeb(fs.createReadStream(file)), 200, headers);
});
