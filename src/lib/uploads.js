// Storage of uploaded photos and documents. Files are identified by a random
// token, live outside the web root and are only served through an
// authenticated route. The type is taken from the file content, never from the
// name or the browser-supplied MIME type.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from '../config.js';
import { formatBytes } from './format.js';

export class UploadError extends Error {}

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, i) => buffer[offset + i] === byte);

/** Detects the supported types from their magic bytes. */
export function sniffType(buffer) {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', extension: 'jpg' };
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', extension: 'png' };
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: 'image/webp', extension: 'webp' };
  }
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', extension: 'gif' };
  // "%PDF-" may be preceded by a few junk bytes in files from old scanners.
  if (buffer.subarray(0, 1024).includes('%PDF-')) return { mime: 'application/pdf', extension: 'pdf' };
  return null;
}

export const isImage = (mime) => mime.startsWith('image/');

function cleanFilename(name, extension) {
  const base = path
    .basename(String(name || 'datei').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\.[^.]{1,5}$/, '')
    .trim()
    .slice(0, 120);
  return `${base || 'datei'}.${extension}`;
}

export function uploadPath(token) {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Ungültiges Datei-Token');
  return path.join(paths.uploads, token.slice(0, 2), token);
}

/**
 * Validates a File from a multipart form and writes it to disk.
 * Returns the metadata to store in the attachments table.
 */
export async function storeUpload(file) {
  if (file.size > config.maxUploadBytes) {
    throw new UploadError(`„${file.name}“ ist zu groß (${formatBytes(file.size)}). Erlaubt sind maximal ${formatBytes(config.maxUploadBytes)}.`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const type = sniffType(buffer);
  if (!type) {
    throw new UploadError(`„${file.name}“ hat ein nicht unterstütztes Format. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF) und PDF-Dateien.`);
  }
  const token = crypto.randomBytes(16).toString('hex');
  const target = uploadPath(token);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer, { flag: 'wx', mode: 0o600 });
  return { token, filename: cleanFilename(file.name, type.extension), mime: type.mime, size: buffer.length };
}

export function removeUpload(token) {
  try {
    fs.unlinkSync(uploadPath(token));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Datei ${token} konnte nicht gelöscht werden:`, error.message);
  }
}

/** Real uploads from a form field: browsers send an empty File when nothing was chosen. */
export function chosenFiles(values) {
  return values.filter((value) => value instanceof File && value.size > 0);
}
