// What a QR label leads to: a compact, phone-friendly page with the quick
// actions for one device – plus the in-app scanner.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { get } from '../../db.js';
import { getAssetByCode } from '../../services/assets.js';
import { listAssetPlans } from '../../services/inspections.js';
import { listAssetDefects } from '../../services/defects.js';
import { cleanText, formatTimestampDate } from '../../lib/format.js';
import { page } from '../layout.js';
import { icon } from '../icons.js';
import { alert, assetStatusBadge, card, conditionBadges, dueText, pageHeader, planBadge, severityBadge } from '../ui.js';

export const scanRoutes = new Hono();

function scanPage(c, asset) {
  const plans = listAssetPlans(asset.id);
  const openDefects = listAssetDefects(asset.id).filter((defect) => defect.status !== 'resolved');
  const action = ({ href, iconName, title, text, tone = '' }) => html`<a class="action${tone ? ` action--${tone}` : ''}" href="${href}">
      <span class="action__icon">${icon(iconName, { size: 22 })}</span>
      <span class="action__text"><span class="action__title">${title}</span>${text ? html`<span class="action__sub">${text}</span>` : ''}</span>
      ${icon('chevron-right', { size: 18, className: 'action__chevron' })}
    </a>`;

  const content = html`<div class="scan">
      <div class="scan__head">
        <p class="scan__number mono">${asset.inventory_number}</p>
        <h1>${asset.name}</h1>
        <p class="muted">${[asset.manufacturer, asset.model, asset.location_name, asset.location_detail].filter(Boolean).join(' · ')}</p>
        <div class="badges">${assetStatusBadge(asset.status)}${conditionBadges(asset)}</div>
      </div>
      <div class="actions">
        ${action({ href: `/inventar/${asset.id}/defekt/neu?von=scan`, iconName: 'triangle-alert', title: 'Defekt melden', text: 'Schaden oder Störung an diesem Gerät', tone: 'danger' })}
        ${plans.map((plan) =>
          action({
            href: `/inventar/${asset.id}/pruefung/neu?typ=${plan.type_id}&von=scan`,
            iconName: 'clipboard-check',
            title: `${plan.type_name} eintragen`,
            text: html`${planBadge(plan.state)} <span>Fällig: ${dueText(plan.next_due)}</span>`,
          }),
        )}
        ${action({ href: `/inventar/${asset.id}/pruefung/neu?von=scan`, iconName: 'plus', title: plans.length > 0 ? 'Andere Prüfung eintragen' : 'Prüfung eintragen', text: plans.length > 0 ? '' : 'Kalibrierung, Elektroprüfung, Wartung …' })}
      </div>
      ${openDefects.length > 0
        ? card({
            title: 'Offene Defekte',
            flush: true,
            body: html`<ul class="list">
              ${openDefects.map(
                (defect) => html`<li class="list__item">
                  <span class="list__main"><a class="list__title" href="/defekte/${defect.id}">${defect.title}</a>
                    <span class="muted">seit ${formatTimestampDate(defect.reported_at)}</span></span>
                  <span class="list__badges">${severityBadge(defect.severity)}</span>
                </li>`,
              )}
            </ul>`,
          })
        : ''}
      <div class="scan__links">
        <a class="btn" href="/inventar/${asset.id}">${icon('file-text', { size: 16 })}Alle Details</a>
        <a class="btn" href="/scannen">${icon('scan-qr-code', { size: 16 })}Nächstes Gerät scannen</a>
      </div>
    </div>`;
  return page(c, { title: asset.name, active: 'scan', narrow: true, content });
}

// Printed codes are upper case, but the link also works when typed in lower case.
scanRoutes.get('/q/:code', (c) => {
  const asset = getAssetByCode(c.req.param('code'));
  if (!asset) {
    return page(c, {
      title: 'Unbekannter Code',
      active: 'scan',
      narrow: true,
      content: html`${pageHeader({ title: 'Unbekannter QR-Code' })}
        ${alert('Zu diesem Code gibt es kein Gerät (mehr). Möglicherweise wurde es gelöscht oder das Etikett stammt aus einer anderen Installation.', 'warning', 'circle-alert')}
        <p><a class="btn btn--primary" href="/inventar">Zum Inventar</a></p>`,
    }, 404);
  }
  return scanPage(c, asset);
});
scanRoutes.get('/Q/:code', (c) => c.redirect(`/q/${encodeURIComponent(c.req.param('code'))}`, 302));

scanRoutes.get('/scannen', (c) => {
  // Manual fallback: inventory number or the code printed in the QR link.
  const query = cleanText(c.req.query('nummer'), 60);
  let notFoundMessage = '';
  if (query) {
    const match = get('SELECT code FROM assets WHERE inventory_number = ? OR code = ?', query, query.toUpperCase());
    if (match) return c.redirect(`/q/${match.code}`, 302);
    notFoundMessage = `Kein Gerät mit der Nummer „${query}“ gefunden.`;
  }
  const content = html`${pageHeader({ title: 'QR-Code scannen', subtitle: 'Kamera auf das Etikett am Gerät richten' })}
    <div class="scanner" data-scanner>
      <div class="scanner__view">
        <video class="scanner__video" playsinline muted></video>
        <div class="scanner__frame" aria-hidden="true"></div>
        <p class="scanner__status" data-scanner-status role="status">Kamera wird gestartet …</p>
      </div>
      <div class="scanner__controls">
        <button type="button" class="btn" data-scanner-start hidden>${icon('camera', { size: 16 })}Kamera starten</button>
        <button type="button" class="btn" data-scanner-torch hidden>${icon('flashlight', { size: 16 })}Licht</button>
      </div>
    </div>
    <noscript>${alert('Der Scanner benötigt JavaScript. Alternativ den QR-Code mit der Kamera-App des Handys scannen.', 'warning', 'circle-alert')}</noscript>
    ${notFoundMessage ? alert(notFoundMessage, 'danger', 'circle-alert') : ''}
    ${card({
      title: 'Ohne Kamera',
      body: html`<form method="get" action="/scannen" class="form form--inline">
          <div class="field"><label class="field__label" for="f-nummer">Inventarnummer</label>
            <input class="input" id="f-nummer" name="nummer" value="${query}" required autocomplete="off" placeholder="z. B. INV-0001" /></div>
          <button type="submit" class="btn">Öffnen</button>
        </form>
        <p class="muted small">Tipp: Die Kamera-App des Handys erkennt die QR-Codes ebenfalls und öffnet das Gerät direkt.</p>`,
    })}`;
  return page(c, { title: 'Scannen', active: 'scan', narrow: true, content, scripts: ['scanner.js'] });
});
