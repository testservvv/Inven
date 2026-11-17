// Photos and documents attached to a device (optionally to one of its defects or inspections).
import { all, get, now, run } from '../db.js';
import { ATTACHMENT_KIND } from '../lib/terms.js';
import { UploadError, isImage, removeUpload, storeUpload } from '../lib/uploads.js';
import { logEvent } from './events.js';

export const MAX_FILES_PER_UPLOAD = 10;

/**
 * Stores uploaded files for a device. Invalid files are skipped and reported;
 * the valid ones are still saved. Returns { saved, errors }.
 */
export async function addAttachments(files, { asset, user, kind = 'photo', defectId = null, inspectionId = null }) {
  const errors = [];
  let saved = 0;
  if (files.length > MAX_FILES_PER_UPLOAD) {
    errors.push(`Es können höchstens ${MAX_FILES_PER_UPLOAD} Dateien auf einmal hochgeladen werden.`);
  }
  for (const file of files.slice(0, MAX_FILES_PER_UPLOAD)) {
    let stored;
    try {
      stored = await storeUpload(file);
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      errors.push(error.message);
      continue;
    }
    // A PDF can never be a "photo": file it as a document instead.
    const fileKind = kind in ATTACHMENT_KIND && (kind !== 'photo' || isImage(stored.mime)) ? kind : 'document';
    run(
      `INSERT INTO attachments (token, asset_id, defect_id, inspection_id, kind, filename, mime, size,
         uploaded_by, uploaded_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      stored.token,
      asset.id,
      defectId,
      inspectionId,
      fileKind,
      stored.filename,
      stored.mime,
      stored.size,
      user.id,
      user.name,
      now(),
    );
    saved++;
  }
  if (saved > 0 && !defectId && !inspectionId) {
    logEvent({ user, asset, action: 'attachment.added', detail: `${saved} ${saved === 1 ? 'Datei' : 'Dateien'} (${ATTACHMENT_KIND[kind] ?? 'Dokument'})` });
  }
  return { saved, errors };
}

/** Members never get to see invoices – they contain purchase prices. */
const visibility = (user) => (user.role === 'admin' ? '' : "AND kind != 'invoice'");

export function listAttachments(assetId, user) {
  return all(`SELECT * FROM attachments WHERE asset_id = ? ${visibility(user)} ORDER BY id`, assetId);
}

export function getAttachmentByToken(token, user) {
  if (!/^[a-f0-9]{32}$/.test(token)) return null;
  return get(`SELECT * FROM attachments WHERE token = ? ${visibility(user)}`, token) ?? null;
}

export const getAttachment = (id) => get('SELECT * FROM attachments WHERE id = ?', id);

export function deleteAttachment(attachment, asset, user) {
  run('DELETE FROM attachments WHERE id = ?', attachment.id);
  removeUpload(attachment.token);
  logEvent({ user, asset, action: 'attachment.removed', detail: attachment.filename });
}

/** The first photo that is not tied to a defect serves as the device picture. */
export function coverPhoto(assetId) {
  return (
    get(
      `SELECT * FROM attachments WHERE asset_id = ? AND kind = 'photo' AND mime LIKE 'image/%'
       ORDER BY (defect_id IS NOT NULL), id LIMIT 1`,
      assetId,
    ) ?? null
  );
}
