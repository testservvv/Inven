// Detail page of a single device.
import { html, raw } from 'hono/html';
import { ASSET_STATUS, ATTACHMENT_KIND, OWNERSHIP } from '../../lib/terms.js';
import { formatDate, formatMoney, formatTimestampDate } from '../../lib/format.js';
import { qrSvg } from '../../lib/qr.js';
import { icon } from '../icons.js';
import { isAdmin, publicOrigin } from '../http.js';
import {
  assetStatusBadge,
  card,
  conditionBadges,
  csrfField,
  defectStatusBadge,
  details,
  dueText,
  emptyState,
  field,
  fileField,
  pageHeader,
  planBadge,
  postButton,
  resultBadge,
  select,
  severityBadge,
} from '../ui.js';
import { fileLinks, fileUrl, gallery, timeline } from './shared.js';

function plansCard(c, asset, { plans, inspections, attachments, types }) {
  const admin = isAdmin(c);
  const unplanned = types.filter((type) => !plans.some((plan) => plan.type_id === type.id));
  const filesOf = (inspection) => attachments.filter((file) => file.inspection_id === inspection.id);

  const planRows = plans.map(
    (plan) => html`<li class="plan">
      <div class="plan__main">
        <p class="plan__title">${plan.type_name} ${planBadge(plan.state)}</p>
        <p class="plan__meta">
          Fällig: ${dueText(plan.next_due)} · alle ${plan.interval_months} Monate
          ${plan.last_performed_on ? html` · zuletzt ${formatDate(plan.last_performed_on)}` : html` · noch nie geprüft`}
        </p>
        ${admin
          ? html`<details class="inline-edit">
              <summary>Plan ändern</summary>
              <form method="post" action="/inventar/${asset.id}/pruefplaene" class="form form--row">
                ${csrfField(c)}
                <input type="hidden" name="type_id" value="${plan.type_id}" />
                ${field({ label: 'Intervall (Monate)', name: `interval_months`, type: 'number', value: plan.interval_months, required: true, id: `f-interval-${plan.id}`, attributes: { min: 1, max: 240 } })}
                ${field({ label: 'Nächste Fälligkeit', name: 'next_due', type: 'date', value: plan.next_due ?? '', id: `f-due-${plan.id}` })}
                <button type="submit" class="btn btn--sm">Speichern</button>
              </form>
              ${postButton(c, { action: `/pruefplaene/${plan.id}/loeschen`, label: 'Plan entfernen', className: 'link-btn link-btn--danger', confirm: `Prüfplan „${plan.type_name}“ entfernen? Bereits eingetragene Prüfungen bleiben erhalten.` })}
            </details>`
          : ''}
      </div>
      <a class="btn btn--sm" href="/inventar/${asset.id}/pruefung/neu?typ=${plan.type_id}">${icon('clipboard-check', { size: 16 })}Eintragen</a>
    </li>`,
  );

  return card({
    title: 'Prüfungen',
    id: 'pruefungen',
    flush: true,
    body: html`${plans.length > 0
        ? html`<ul class="plans">${planRows}</ul>`
        : emptyState({ iconName: 'clipboard-check', title: 'Keine Prüfpflichten hinterlegt', text: admin ? 'Lege unten fest, welche Prüfungen dieses Gerät regelmäßig braucht.' : '' })}
      ${admin && unplanned.length > 0
        ? html`<details class="card__section inline-edit"${plans.length === 0 ? raw(' open') : ''}>
            <summary>${icon('plus', { size: 15 })}Prüfplan hinzufügen</summary>
            <form method="post" action="/inventar/${asset.id}/pruefplaene" class="form form--row">
              ${csrfField(c)}
              ${select({ label: 'Prüfart', name: 'type_id', required: true, options: unplanned.map((type) => ({ value: type.id, label: `${type.name} (alle ${type.default_interval_months} Monate)` })), id: 'f-new-plan-type' })}
              ${field({ label: 'Intervall (Monate)', name: 'interval_months', type: 'number', hint: 'leer = Standard', id: 'f-new-plan-interval', attributes: { min: 1, max: 240 } })}
              ${field({ label: 'Nächste Fälligkeit', name: 'next_due', type: 'date', id: 'f-new-plan-due' })}
              <button type="submit" class="btn btn--sm">Hinzufügen</button>
            </form>
          </details>`
        : ''}
      ${inspections.length > 0
        ? html`<div class="card__section">
            <h3 class="section-title">Prüfprotokoll</h3>
            <div class="table-wrap table-wrap--plain">
              <table class="table table--compact">
                <thead><tr><th>Datum</th><th>Prüfart</th><th>Ergebnis</th><th class="hide-sm">Prüfer</th><th class="hide-sm">Nachweis</th><th></th></tr></thead>
                <tbody>
                  ${inspections.map(
                    (item) => html`<tr>
                      <td class="nowrap">${formatDate(item.performed_on)}</td>
                      <td>${item.type_name}${item.notes ? html`<span class="cell-sub">${item.notes}</span>` : ''}</td>
                      <td>${resultBadge(item.result)}</td>
                      <td class="hide-sm">${item.inspector ?? html`<span class="muted">–</span>`}</td>
                      <td class="hide-sm">${item.certificate_number ?? ''} ${fileLinks(filesOf(item))}</td>
                      <td class="table__actions">${admin
                        ? postButton(c, { action: `/pruefungen/${item.id}/loeschen`, label: '', iconName: 'trash-2', className: 'icon-btn icon-btn--sm', title: 'Eintrag löschen', confirm: `Prüfeintrag „${item.type_name}“ vom ${formatDate(item.performed_on)} löschen?` })
                        : ''}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>
          </div>`
        : ''}`,
  });
}

function defectsCard(asset, defects) {
  return card({
    title: 'Defekte',
    id: 'defekte',
    flush: true,
    action: html`<a class="btn btn--sm" href="/inventar/${asset.id}/defekt/neu">${icon('plus', { size: 16 })}Melden</a>`,
    body:
      defects.length === 0
        ? emptyState({ iconName: 'circle-check', title: 'Keine Defekte gemeldet' })
        : html`<ul class="list">
            ${defects.map(
              (defect) => html`<li class="list__item">
                <span class="list__main">
                  <a class="list__title" href="/defekte/${defect.id}">${defect.title}</a>
                  <span class="muted">Gemeldet am ${formatTimestampDate(defect.reported_at)}${defect.reported_by_name ? ` von ${defect.reported_by_name}` : ''}</span>
                </span>
                <span class="list__badges">${severityBadge(defect.severity)}${defectStatusBadge(defect.status)}</span>
              </li>`,
            )}
          </ul>`,
  });
}

function filesCard(c, asset, attachments) {
  const admin = isAdmin(c);
  return card({
    title: 'Fotos & Belege',
    id: 'dateien',
    body: html`${attachments.length > 0 ? gallery(c, attachments, { canDelete: admin }) : html`<p class="muted">Noch keine Dateien vorhanden.</p>`}
      ${admin
        ? html`<form method="post" action="/inventar/${asset.id}/anhaenge" enctype="multipart/form-data" class="form form--row upload">
            ${csrfField(c)}
            ${select({ label: 'Art', name: 'kind', value: 'photo', options: Object.entries(ATTACHMENT_KIND).map(([value, label]) => ({ value, label })) })}
            ${fileField({ label: 'Dateien', name: 'files', hint: 'Bilder oder PDF' })}
            <button type="submit" class="btn btn--sm">${icon('upload', { size: 16 })}Hochladen</button>
          </form>`
        : ''}`,
  });
}

export function assetDetail(c, asset, data) {
  const admin = isAdmin(c);
  const scanUrl = `${publicOrigin(c)}/q/${asset.code}`;
  const { cover } = data;

  const actions = html`<a class="btn" href="/inventar/${asset.id}/defekt/neu">${icon('triangle-alert', { size: 16 })}Defekt melden</a>
    <a class="btn" href="/inventar/${asset.id}/pruefung/neu">${icon('clipboard-check', { size: 16 })}Prüfung eintragen</a>
    ${admin
      ? html`<a class="btn btn--primary" href="/inventar/${asset.id}/bearbeiten">${icon('pencil', { size: 16 })}Bearbeiten</a>
          <details class="dropdown">
            <summary class="btn btn--icon" aria-label="Weitere Aktionen">${icon('ellipsis')}</summary>
            <div class="dropdown__menu">
              <a class="dropdown__item" href="/inventar/neu?kopie=${asset.id}">${icon('copy', { size: 16 })}Duplizieren</a>
              <a class="dropdown__item" href="/etiketten?ids=${asset.id}">${icon('printer', { size: 16 })}Etikett drucken</a>
              ${postButton(c, { action: `/inventar/${asset.id}/loeschen`, label: 'Löschen', iconName: 'trash-2', className: 'dropdown__item dropdown__item--danger', confirm: `„${asset.name}“ (${asset.inventory_number}) endgültig löschen? Alle Defekte, Prüfungen und Dateien dieses Geräts gehen verloren. Tipp: Ausgemusterte Geräte lieber auf „Ausgemustert“ setzen.` })}
            </div>
          </details>`
      : ''}`;

  const main = html`${card({
      title: 'Stammdaten',
      body: details([
        ['Inventarnummer', html`<span class="mono">${asset.inventory_number}</span>`],
        ['Kategorie', asset.category_name],
        ['Hersteller', asset.manufacturer],
        ['Modell / Typ', asset.model],
        ['Seriennummer', asset.serial_number ? html`<span class="mono">${asset.serial_number}</span>` : null],
        ['Standort', [asset.location_name, asset.location_detail].filter(Boolean).join(' · ')],
        ['Verantwortlich', asset.assigned_to],
        ['Status', ASSET_STATUS[asset.status]],
        asset.notes ? ['Notizen', html`<span class="prewrap">${asset.notes}</span>`] : null,
      ]),
    })}
    ${plansCard(c, asset, data)}
    ${defectsCard(asset, data.defects)}
    ${filesCard(c, asset, data.attachments)}
    ${card({ title: 'Verlauf', body: data.events.length > 0 ? timeline(data.events) : html`<p class="muted">Noch keine Einträge.</p>` })}`;

  const aside = html`${cover ? html`<a class="cover" href="${fileUrl(cover)}" target="_blank" rel="noopener"><img src="${fileUrl(cover)}" alt="Foto: ${asset.name}" /></a>` : ''}
    ${card({
      title: 'QR-Code',
      className: 'qr-card',
      body: html`<div class="qr-card__code">${raw(qrSvg(scanUrl, { margin: 2, title: asset.inventory_number }))}</div>
        <p class="qr-card__text">Scannen öffnet dieses Gerät – zum Melden von Defekten und Eintragen von Prüfungen.</p>
        <div class="qr-card__actions">
          ${admin ? html`<a class="btn btn--sm" href="/etiketten?ids=${asset.id}">${icon('printer', { size: 16 })}Etikett</a>` : ''}
          <a class="btn btn--sm" href="/inventar/${asset.id}/qr.svg" download="${asset.inventory_number}.svg">${icon('download', { size: 16 })}SVG</a>
          <a class="btn btn--sm" href="/q/${asset.code}">${icon('smartphone', { size: 16 })}Scan-Ansicht</a>
        </div>`,
    })}
    ${admin
      ? card({
          title: 'Anschaffung & Versicherung',
          body: details([
            ['Kaufdatum', asset.purchase_date ? formatDate(asset.purchase_date) : null],
            ['Anschaffungspreis', asset.purchase_price_cents !== null ? formatMoney(asset.purchase_price_cents) : null],
            ['Lieferant', asset.supplier],
            ['Rechnungsnummer', asset.invoice_number],
            ['Garantie bis', asset.warranty_until ? formatDate(asset.warranty_until) : null],
            ['Eigentum', OWNERSHIP[asset.ownership]],
            ['Versicherung', asset.policy_name ?? html`<span class="text-warning">nicht zugeordnet</span>`],
            ['Versicherungswert', asset.value_cents !== null ? html`${formatMoney(asset.value_cents)}${asset.insured_value_cents === null ? html` <span class="muted">(= Anschaffungspreis)</span>` : ''}` : null],
          ]),
        })
      : ''}`;

  return html`${pageHeader({
      title: asset.name,
      subtitle: [asset.inventory_number, asset.category_name, asset.location_name].filter(Boolean).join(' · '),
      back: { href: '/inventar', label: 'Inventar' },
      badges: html`${assetStatusBadge(asset.status)}${conditionBadges(asset)}`,
      actions,
    })}
    <div class="detail-grid">
      <div class="stack">${main}</div>
      <aside class="stack">${aside}</aside>
    </div>`;
}
