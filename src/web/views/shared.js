// View fragments used on several pages.
import { html } from 'hono/html';
import { ATTACHMENT_KIND } from '../../lib/terms.js';
import { isImage } from '../../lib/uploads.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { ACTION_LABEL } from '../../services/events.js';
import { icon } from '../icons.js';
import { postButton } from '../ui.js';

export const fileUrl = (attachment) => `/dateien/${attachment.token}/${encodeURIComponent(attachment.filename)}`;

/** Thumbnails for images, tiles for PDFs. */
export function gallery(c, attachments, { canDelete = false } = {}) {
  if (attachments.length === 0) return '';
  return html`<ul class="gallery">
    ${attachments.map(
      (file) => html`<li class="gallery__item">
        <a class="gallery__link" href="${fileUrl(file)}" target="_blank" rel="noopener" title="${file.filename}">
          ${isImage(file.mime)
            ? html`<img src="${fileUrl(file)}" alt="${file.filename}" loading="lazy" />`
            : html`<span class="gallery__doc">${icon('file-text', { size: 26 })}<span>PDF</span></span>`}
        </a>
        <div class="gallery__meta">
          <span class="gallery__name" title="${file.filename}">${ATTACHMENT_KIND[file.kind]}</span>
          <span class="muted">${formatBytes(file.size)}</span>
        </div>
        ${canDelete
          ? postButton(c, {
              action: `/anhaenge/${file.id}/loeschen`,
              label: '',
              iconName: 'trash-2',
              className: 'icon-btn icon-btn--sm gallery__delete',
              title: 'Datei löschen',
              confirm: `„${file.filename}“ wirklich löschen?`,
            })
          : ''}
      </li>`,
    )}
  </ul>`;
}

/** Small file links, e.g. the certificate next to an inspection record. */
export function fileLinks(attachments) {
  return attachments.map(
    (file) => html`<a class="file-chip" href="${fileUrl(file)}" target="_blank" rel="noopener" title="${file.filename}">${icon(isImage(file.mime) ? 'image' : 'file-text', { size: 14 })}${isImage(file.mime) ? 'Foto' : 'PDF'}</a>`,
  );
}

export function timeline(events, { showAsset = false } = {}) {
  return html`<ol class="timeline">
    ${events.map(
      (event) => html`<li class="timeline__item">
        <span class="timeline__dot"></span>
        <div>
          <p class="timeline__title">${ACTION_LABEL[event.action] ?? event.action}${showAsset && event.asset_label
            ? html` · ${event.asset_id ? html`<a href="/inventar/${event.asset_id}">${event.asset_label}</a>` : event.asset_label}`
            : ''}</p>
          ${event.detail ? html`<p class="timeline__detail">${event.detail}</p>` : ''}
          <p class="timeline__meta">${formatDateTime(event.created_at)}${event.user_name ? ` · ${event.user_name}` : ''}</p>
        </div>
      </li>`,
    )}
  </ol>`;
}
