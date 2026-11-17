// QR label printing (PDF).
import { Hono } from 'hono';
import { html } from 'hono/html';
import { listAssets } from '../../services/assets.js';
import { companyName, getSetting, setSetting } from '../../services/settings.js';
import { DEFAULT_FORMAT, LABEL_FORMATS, MAX_LABELS, renderLabels, resolveFormat } from '../../lib/labels.js';
import { cleanText, plural } from '../../lib/format.js';
import { page } from '../layout.js';
import { publicOrigin, requireAdmin } from '../http.js';
import { icon } from '../icons.js';
import { alert, card, checkbox, emptyState, field, pageHeader } from '../ui.js';

export const labelRoutes = new Hono();
labelRoutes.use('/etiketten', requireAdmin);
labelRoutes.use('/etiketten/*', requireAdmin);

/** Selected device ids from "?ids=1&ids=2" or "?ids=1,2". Empty = all devices in stock. */
function selectedIds(c) {
  const ids = (c.req.queries('ids') ?? []).flatMap((value) => value.split(',')).filter((value) => /^\d+$/.test(value)).map(Number);
  return [...new Set(ids)].slice(0, MAX_LABELS);
}

function labelAssets(c) {
  const ids = selectedIds(c);
  const filters = ids.length > 0 ? { ids } : { status: 'stock' };
  return { ids, assets: listAssets(filters, { sort: 'inv', pageSize: 0 }).rows.slice(0, MAX_LABELS) };
}

labelRoutes.get('/etiketten', (c) => {
  const { ids, assets } = labelAssets(c);
  const stored = getSetting('label_format') || DEFAULT_FORMAT;
  const footer = getSetting('label_footer') || (companyName() ? `Eigentum: ${companyName()}` : '');
  const group = (sheet) => LABEL_FORMATS.filter((format) => format.sheet === sheet).map(
    (format) => html`<option value="${format.id}"${format.id === stored ? html` selected` : ''}>${format.name} (${format.hint})</option>`,
  );
  const num = (label, name, value, hint = '') => field({ label, name, value, hint, attributes: { inputmode: 'decimal' } });

  const content = html`${pageHeader({
      title: 'QR-Etiketten',
      subtitle: ids.length > 0 ? `${plural(assets.length, 'ausgewähltes Gerät', 'ausgewählte Geräte')}` : `Alle ${plural(assets.length, 'Gerät', 'Geräte')} im Bestand`,
      back: ids.length > 0 ? { href: '/inventar', label: 'Inventar' } : null,
    })}
    ${assets.length === 0
      ? emptyState({ iconName: 'qr-code', title: 'Keine Geräte vorhanden', text: 'Lege zuerst Geräte an – jedes erhält automatisch einen eigenen QR-Code.' })
      : html`<div class="detail-grid detail-grid--even">
          <form method="get" action="/etiketten/pdf" target="_blank" class="card form form--page" data-label-form>
            ${ids.map((id) => html`<input type="hidden" name="ids" value="${id}" />`)}
            <div class="field">
              <label class="field__label" for="f-format">Etikettenformat</label>
              <select class="input" id="f-format" name="format" data-label-format>
                <optgroup label="A4-Bogen (normaler Drucker)">${group(true)}<option value="custom-sheet"${stored === 'custom-sheet' ? html` selected` : ''}>Eigener A4-Bogen …</option></optgroup>
                <optgroup label="Etikettendrucker (ein Etikett pro Seite)">${group(false)}<option value="custom-roll"${stored === 'custom-roll' ? html` selected` : ''}>Eigenes Format …</option></optgroup>
              </select>
            </div>
            <div class="form-grid" data-label-custom="custom-sheet custom-roll" hidden>
              ${num('Etikettenbreite (mm)', 'width', '')}
              ${num('Etikettenhöhe (mm)', 'height', '')}
            </div>
            <div class="form-grid form-grid--3" data-label-custom="custom-sheet" hidden>
              ${num('Spalten', 'cols', '')}
              ${num('Zeilen', 'rows', '')}
              ${num('Rand links (mm)', 'left', '')}
              ${num('Rand oben (mm)', 'top', '')}
              ${num('Abstand horizontal (mm)', 'gapX', '')}
              ${num('Abstand vertikal (mm)', 'gapY', '')}
            </div>
            ${field({ label: 'Zusatzzeile', name: 'footer', value: footer, hint: 'Kleine Zeile unten, z. B. „Eigentum: Muster GmbH“. Leer = keine.', attributes: { maxlength: 60 } })}
            <div data-label-sheet-only>
              ${field({ label: 'Erstes Etikett überspringen', name: 'skip', type: 'number', value: 0, hint: 'Anzahl bereits verbrauchter Etiketten auf dem ersten Bogen.', attributes: { min: 0, max: 200 } })}
            </div>
            <details class="inline-edit">
              <summary>Feinjustierung</summary>
              <div class="form-grid" data-label-sheet-only>
                ${num('Versatz nach rechts (mm)', 'dx', '0', 'negativ = nach links')}
                ${num('Versatz nach unten (mm)', 'dy', '0', 'negativ = nach oben')}
              </div>
              ${checkbox({ label: 'Etikettenrahmen mitdrucken', name: 'rahmen', hint: 'Für einen Probedruck auf Normalpapier – zum Abgleich gegen den Etikettenbogen halten.' })}
            </details>
            <div class="form-actions">
              <button type="submit" class="btn btn--primary">${icon('printer', { size: 16 })}PDF erzeugen</button>
            </div>
            ${alert(html`Beim Drucken <strong>„Tatsächliche Größe“ / 100 %</strong> wählen – nicht „An Seite anpassen“.`, 'info', 'info')}
          </form>
          ${card({
            title: 'Vorschau',
            className: 'label-preview',
            body: html`<iframe class="label-preview__frame" title="Vorschau der Etiketten" data-label-preview></iframe>
              <p class="muted small">Die Vorschau zeigt das PDF. Falls sie leer bleibt, „PDF erzeugen“ verwenden.</p>`,
          })}
        </div>`}`;
  return page(c, { title: 'QR-Etiketten', active: 'labels', content });
});

labelRoutes.get('/etiketten/pdf', async (c) => {
  const { assets } = labelAssets(c);
  const params = c.req.query();
  const format = resolveFormat(params);
  const origin = publicOrigin(c);
  const offset = (raw) => Math.min(20, Math.max(-20, Number.parseFloat(String(raw ?? '0').replace(',', '.')) || 0));
  const footer = cleanText(params.footer, 60);

  // Remember the last choice so the next print starts with it (not for the preview).
  if (!params.vorschau) {
    if (LABEL_FORMATS.some((item) => item.id === format.id) || format.id.startsWith('custom-')) setSetting('label_format', format.id);
    setSetting('label_footer', footer);
  }

  const pdf = await renderLabels({
    format,
    items: assets.map((asset) => ({ url: `${origin}/q/${asset.code}`, number: asset.inventory_number, title: asset.name })),
    footer,
    skip: Number.parseInt(params.skip ?? '0', 10) || 0,
    offsetX: offset(params.dx),
    offsetY: offset(params.dy),
    outline: Boolean(params.rahmen),
  });
  return c.body(pdf, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="inventar-etiketten.pdf"',
    // The label page embeds this PDF as a preview.
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "frame-ancestors 'self'",
  });
});
