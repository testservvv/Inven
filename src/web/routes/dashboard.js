// Start page: what needs attention today.
import { Hono } from 'hono';
import { html } from 'hono/html';
import { assetStats } from '../../services/assets.js';
import { defectCounts, listDefects } from '../../services/defects.js';
import { listPlans, planCounts } from '../../services/inspections.js';
import { listPolicies } from '../../services/masterdata.js';
import { listEvents } from '../../services/events.js';
import { formatDate, formatMoney, formatTimestampDate, plural, today } from '../../lib/format.js';
import { page } from '../layout.js';
import { isAdmin } from '../http.js';
import { icon } from '../icons.js';
import { badge, card, dueText, emptyState, pageHeader, planBadge, severityBadge } from '../ui.js';
import { timeline } from '../views/shared.js';

export const dashboardRoutes = new Hono();

function stat({ label, value, sub = '', href, tone = '' }) {
  return html`<a class="stat${tone ? ` stat--${tone}` : ''}" href="${href}">
    <span class="stat__label">${label}</span>
    <span class="stat__value">${value}</span>
    <span class="stat__sub">${sub}</span>
  </a>`;
}

/** Share of a policy's insured sum that is covered by recorded devices. */
function coverage(policy) {
  if (!policy.sum_insured_cents) return html`<span class="muted">keine Summe hinterlegt</span>`;
  const ratio = policy.covered_cents / policy.sum_insured_cents;
  const over = ratio > 1;
  return html`<div class="meter${over ? ' meter--over' : ''}">
    <svg class="meter__bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">
      <rect class="meter__track" width="100" height="6" rx="3" /><rect class="meter__fill" width="${Math.min(100, Math.round(ratio * 100))}" height="6" rx="3" />
    </svg>
    <span class="meter__text">${Math.round(ratio * 100)} %${over ? ' – Unterversicherung möglich' : ''}</span>
  </div>`;
}

dashboardRoutes.get('/', (c) => {
  const admin = isAdmin(c);
  const assets = assetStats();
  const defects = defectCounts();
  const plans = planCounts();
  const urgent = plans.failed + plans.overdue;
  const dueSoon = plans.soon + plans.open;
  const duePlans = listPlans({ state: 'action' }, { pageSize: 6 }).rows;
  const openDefects = listDefects({ status: 'open' }, { pageSize: 6 }).rows;

  const stats = html`<div class="stats">
    ${stat({ label: 'Geräte im Bestand', value: assets.in_stock, sub: assets.total > assets.in_stock ? `${assets.total - assets.in_stock} ausgemustert / Verlust` : 'aktuell erfasst', href: '/inventar?status=stock' })}
    ${admin ? stat({ label: 'Versicherungswert', value: formatMoney(assets.value_cents), sub: assets.uninsured > 0 ? `${plural(assets.uninsured, 'Gerät', 'Geräte')} ohne Versicherung` : 'alle Geräte zugeordnet', href: assets.uninsured > 0 ? '/inventar?versicherung=none&status=stock' : '/inventar', tone: assets.uninsured > 0 ? 'warning' : '' }) : ''}
    ${stat({ label: 'Offene Defekte', value: defects.open, sub: defects.critical > 0 ? `davon ${defects.critical} kritisch` : defects.open > 0 ? 'keiner kritisch' : 'alles in Ordnung', href: '/defekte', tone: defects.critical > 0 ? 'danger' : defects.open > 0 ? 'warning' : 'success' })}
    ${stat({ label: 'Prüfungen überfällig', value: urgent, sub: dueSoon > 0 ? `${dueSoon} bald fällig` : 'keine weiteren anstehend', href: urgent > 0 ? '/pruefungen?stand=overdue' : '/pruefungen', tone: urgent > 0 ? 'danger' : dueSoon > 0 ? 'warning' : 'success' })}
  </div>`;

  const inspectionsCard = card({
    title: 'Anstehende Prüfungen',
    action: html`<a class="link" href="/pruefungen">Alle anzeigen</a>`,
    flush: true,
    body:
      duePlans.length === 0
        ? emptyState({ iconName: 'circle-check', title: 'Nichts fällig', text: plans.total === 0 ? 'Noch keine Prüfpflichten hinterlegt.' : 'Alle Prüfungen sind aktuell.' })
        : html`<ul class="list">
            ${duePlans.map(
              (plan) => html`<li class="list__item">
                <span class="list__main"><a class="list__title" href="/inventar/${plan.asset_id}#pruefungen">${plan.asset_name}</a>
                  <span class="muted">${plan.type_name} · ${plan.next_due ? dueText(plan.next_due) : 'kein Termin hinterlegt'}</span></span>
                <span class="list__badges">${planBadge(plan.state)}</span>
              </li>`,
            )}
          </ul>`,
  });

  const defectsCard = card({
    title: 'Offene Defekte',
    action: html`<a class="link" href="/defekte">Alle anzeigen</a>`,
    flush: true,
    body:
      openDefects.length === 0
        ? emptyState({ iconName: 'circle-check', title: 'Keine offenen Defekte' })
        : html`<ul class="list">
            ${openDefects.map(
              (defect) => html`<li class="list__item">
                <span class="list__main"><a class="list__title" href="/defekte/${defect.id}">${defect.title}</a>
                  <span class="muted">${defect.asset_name} · seit ${formatTimestampDate(defect.reported_at)}</span></span>
                <span class="list__badges">${severityBadge(defect.severity)}</span>
              </li>`,
            )}
          </ul>`,
  });

  let adminCards = '';
  if (admin) {
    const policies = listPolicies();
    const day = today();
    adminCards = html`${card({
        title: 'Versicherungen',
        action: html`<a class="link" href="/stammdaten#versicherungen">Verwalten</a>`,
        flush: true,
        body:
          policies.length === 0
            ? emptyState({ iconName: 'shield', title: 'Noch keine Versicherung hinterlegt', text: 'Mit hinterlegter Versicherungssumme siehst du hier, ob die erfassten Werte noch gedeckt sind.', action: html`<a class="btn" href="/stammdaten#versicherungen">Versicherung anlegen</a>` })
            : html`<div class="table-wrap table-wrap--plain"><table class="table">
                <thead><tr><th>Versicherung</th><th class="table__number hide-sm">Geräte</th><th class="table__number">Erfasster Wert</th><th class="table__number hide-sm">Versicherungssumme</th><th>Auslastung</th></tr></thead>
                <tbody>
                  ${policies.map(
                    (policy) => html`<tr>
                      <td class="table__primary"><a href="/inventar?versicherung=${policy.id}">${policy.name}</a>
                        <span class="cell-sub">${[policy.insurer, policy.policy_number].filter(Boolean).join(' · ')}</span>
                        ${policy.valid_until && policy.valid_until < day ? html`<span class="cell-sub">${badge(`abgelaufen am ${formatDate(policy.valid_until)}`, 'danger')}</span>` : ''}</td>
                      <td class="table__number hide-sm">${policy.asset_count}</td>
                      <td class="table__number nowrap">${formatMoney(policy.covered_cents)}</td>
                      <td class="table__number nowrap hide-sm">${policy.sum_insured_cents !== null ? formatMoney(policy.sum_insured_cents) : html`<span class="muted">–</span>`}</td>
                      <td>${coverage(policy)}</td>
                    </tr>`,
                  )}
                </tbody>
              </table></div>`,
      })}
      ${card({ title: 'Letzte Aktivität', action: html`<a class="link" href="/aktivitaet">Alle anzeigen</a>`, body: timeline(listEvents({ limit: 6 }).rows, { showAsset: true }) })}`;
  }

  const content = html`${pageHeader({
      title: `Hallo ${c.get('user').name.split(' ')[0]}`,
      subtitle: 'Das Wichtigste auf einen Blick',
      actions: html`<a class="btn" href="/scannen">${icon('scan-qr-code', { size: 16 })}Scannen</a>
        ${admin ? html`<a class="btn btn--primary" href="/inventar/neu">${icon('plus', { size: 16 })}Gerät hinzufügen</a>` : ''}`,
    })}
    ${stats}
    <div class="grid-2">${inspectionsCard}${defectsCard}</div>
    <div class="stack">${adminCards}</div>`;
  return page(c, { title: 'Übersicht', active: 'dashboard', content });
});
