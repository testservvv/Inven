// CSV import and export (admin only).
import { Hono } from 'hono';
import { html } from 'hono/html';
import { listAssets } from '../../services/assets.js';
import { listDefects } from '../../services/defects.js';
import { listInspections, listPlans } from '../../services/inspections.js';
import {
  autoMap,
  discardUpload,
  exportAssets,
  importFields,
  loadUpload,
  prepareImport,
  runImport,
  stashUpload,
  templateRows,
} from '../../services/importer.js';
import { decodeCsv, parseCsv, toCsv } from '../../lib/csv.js';
import { DEFECT_STATUS, PLAN_STATE, RESULT, SEVERITY } from '../../lib/terms.js';
import { formatAmount, formatDate, formatTimestampDate, plural, today } from '../../lib/format.js';
import { page } from '../layout.js';
import { readForm, redirect, requireAdmin } from '../http.js';
import { icon } from '../icons.js';
import { alert, badge, card, checkbox, csrfField, pageHeader } from '../ui.js';
import { assetFilters, assetSort } from './assets.js';

const MAX_ROWS = 5000;

export const dataRoutes = new Hono();
dataRoutes.use('/daten', requireAdmin);
dataRoutes.use('/export/*', requireAdmin);
dataRoutes.use('/import', requireAdmin);
dataRoutes.use('/import/*', requireAdmin);

function download(c, name, rows) {
  return c.body(toCsv(rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}-${today()}.csv"`,
  });
}

dataRoutes.get('/export/inventar.csv', (c) => {
  const { rows } = listAssets(assetFilters(c), { ...assetSort(c), pageSize: 0 });
  return download(c, 'inventar', exportAssets(rows));
});

dataRoutes.get('/export/vorlage.csv', (c) => download(c, 'inventar-vorlage', templateRows()));

dataRoutes.get('/export/defekte.csv', (c) => {
  const { rows } = listDefects({ status: 'all' }, { pageSize: 0 });
  return download(c, 'defekte', [
    ['Inventarnummer', 'Gerät', 'Defekt', 'Beschreibung', 'Schweregrad', 'Status', 'Gemeldet am', 'Gemeldet von', 'Behoben am', 'Behoben von', 'Maßnahme', 'Reparaturkosten'],
    ...rows.map((d) => [
      d.inventory_number, d.asset_name, d.title, d.description, SEVERITY[d.severity], DEFECT_STATUS[d.status],
      formatTimestampDate(d.reported_at), d.reported_by_name, d.resolved_at ? formatTimestampDate(d.resolved_at) : '', d.resolved_by_name, d.resolution, formatAmount(d.repair_cost_cents),
    ]),
  ]);
});

dataRoutes.get('/export/pruefungen.csv', (c) => {
  const { rows } = listPlans({}, { pageSize: 0 });
  return download(c, 'pruefungen-stand', [
    ['Inventarnummer', 'Gerät', 'Standort', 'Prüfart', 'Intervall (Monate)', 'Letzte Prüfung', 'Letztes Ergebnis', 'Nächste Fälligkeit', 'Stand'],
    ...rows.map((p) => [
      p.inventory_number, p.asset_name, p.location_name, p.type_name, p.interval_months,
      p.last_performed_on ? formatDate(p.last_performed_on) : '', p.last_result ? RESULT[p.last_result] : '', p.next_due ? formatDate(p.next_due) : '', PLAN_STATE[p.state],
    ]),
  ]);
});

dataRoutes.get('/export/pruefprotokoll.csv', (c) => {
  const { rows } = listInspections({}, { pageSize: 0 });
  return download(c, 'pruefprotokoll', [
    ['Datum', 'Inventarnummer', 'Gerät', 'Prüfart', 'Ergebnis', 'Prüfer / Prüfstelle', 'Zertifikat-Nr.', 'Bemerkung', 'Nächste Fälligkeit', 'Eingetragen von'],
    ...rows.map((i) => [
      formatDate(i.performed_on), i.inventory_number, i.asset_name, i.type_name, RESULT[i.result], i.inspector, i.certificate_number, i.notes,
      i.next_due ? formatDate(i.next_due) : '', i.created_by_name,
    ]),
  ]);
});

dataRoutes.get('/daten', (c) => {
  const link = (href, title, text) => html`<a class="action" href="${href}">
      <span class="action__icon">${icon('download', { size: 20 })}</span>
      <span class="action__text"><span class="action__title">${title}</span><span class="action__sub">${text}</span></span>
    </a>`;
  const content = html`${pageHeader({ title: 'Import & Export', subtitle: 'Listen als CSV-Datei für Excel, den Versicherer oder Prüfer' })}
    <div class="grid-2 grid-2--top">
      ${card({
        title: 'Export',
        body: html`<div class="actions">
          ${link('/export/inventar.csv', 'Inventarliste', 'Alle Geräte mit Werten und Versicherung')}
          ${link('/export/pruefungen.csv', 'Prüfungen – aktueller Stand', 'Fälligkeiten aller Geräte')}
          ${link('/export/pruefprotokoll.csv', 'Prüfprotokoll', 'Alle eingetragenen Prüfungen')}
          ${link('/export/defekte.csv', 'Defekte', 'Alle Meldungen inkl. Maßnahmen')}
        </div>
        <p class="muted small">Tipp: Im Inventar exportiert „CSV-Export“ genau die gerade gefilterte Ansicht.</p>`,
      })}
      ${card({
        title: 'Import',
        body: html`<p>Bestehende Listen aus Excel übernehmen: in Excel „Speichern unter → CSV UTF-8 (durch Trennzeichen getrennt)“ wählen und die Datei hier hochladen. Die Spalten ordnest du im nächsten Schritt zu – importiert wird erst nach deiner Bestätigung.</p>
          <form method="post" action="/import" enctype="multipart/form-data" class="form">
            ${csrfField(c)}
            <div class="field"><label class="field__label" for="f-csv">CSV-Datei</label>
              <input class="input input--file" id="f-csv" type="file" name="file" accept=".csv,text/csv,text/plain" required /></div>
            <div class="form-actions form-actions--start">
              <button type="submit" class="btn btn--primary">${icon('upload', { size: 16 })}Hochladen & prüfen</button>
              <a class="btn" href="/export/vorlage.csv">${icon('file-spreadsheet', { size: 16 })}Vorlage herunterladen</a>
            </div>
          </form>`,
      })}
    </div>`;
  return page(c, { title: 'Import & Export', active: 'data', content });
});

function importPage(c, { token, rows, mapping, updateExisting }, status = 200) {
  const headers = rows[0];
  const fields = importFields();
  const prepared = prepareImport(rows, mapping, updateExisting);
  const ready = prepared.create + prepared.update;
  const problems = prepared.items.filter((item) => item.action === 'invalid');
  const columnOptions = (selected) => html`<option value="">– nicht importieren –</option>
    ${headers.map((header, index) => html`<option value="${index}"${selected === index ? html` selected` : ''}>${header || `Spalte ${index + 1}`}</option>`)}`;

  const content = html`${pageHeader({ title: 'CSV-Import prüfen', subtitle: `${plural(rows.length - 1, 'Zeile', 'Zeilen')} in der Datei`, back: { href: '/daten', label: 'Import & Export' } })}
    <form method="post" action="/import/pruefen" class="stack">
      ${csrfField(c)}
      <input type="hidden" name="token" value="${token}" />
      ${card({
        title: '1 · Spalten zuordnen',
        body: html`<p class="muted">Erkannte Spalten sind bereits zugeordnet. Pflicht ist nur die Bezeichnung.</p>
          <div class="mapping">
            ${fields.map(
              (field) => html`<label class="mapping__row" for="f-map-${field.key}">
                <span class="mapping__label">${field.label}${field.key === 'name' ? html`<span class="field__required"> *</span>` : ''}</span>
                <select class="input" id="f-map-${field.key}" name="map_${field.key}">${columnOptions(mapping[field.key])}</select>
              </label>`,
            )}
          </div>
          ${checkbox({ label: 'Vorhandene Geräte aktualisieren', name: 'update', checked: updateExisting, hint: 'Zeilen, deren Inventarnummer schon existiert, überschreiben die gefüllten Felder des Geräts. Sonst werden sie übersprungen.' })}
          <div class="form-actions form-actions--start"><button type="submit" class="btn">${icon('rotate-ccw', { size: 16 })}Zuordnung neu prüfen</button></div>`,
      })}
      ${card({
        title: '2 · Ergebnis der Prüfung',
        body: html`<div class="badges">
            ${badge(`${prepared.create} neu`, prepared.create > 0 ? 'success' : 'neutral')}
            ${badge(`${prepared.update} zu aktualisieren`, prepared.update > 0 ? 'info' : 'neutral')}
            ${badge(`${prepared.invalid} mit Fehlern`, prepared.invalid > 0 ? 'danger' : 'neutral')}
          </div>
          ${problems.length > 0
            ? html`<p>Fehlerhafte Zeilen werden übersprungen:</p>
                <div class="table-wrap table-wrap--plain"><table class="table table--compact">
                  <thead><tr><th>Zeile</th><th>Gerät</th><th>Problem</th></tr></thead>
                  <tbody>${problems.slice(0, 50).map((item) => html`<tr><td>${item.line}</td><td>${item.label}</td><td class="text-danger">${item.errors.join('; ')}</td></tr>`)}</tbody>
                </table></div>
                ${problems.length > 50 ? html`<p class="muted small">… und ${problems.length - 50} weitere.</p>` : ''}`
            : html`<p class="muted">Keine Fehler gefunden.</p>`}
          <div class="form-actions form-actions--start">
            <button type="submit" formaction="/import/ausfuehren" class="btn btn--primary"${ready === 0 ? html` disabled` : ''}>${icon('check', { size: 16 })}${plural(ready, 'Gerät', 'Geräte')} importieren</button>
            <a class="btn" href="/daten">Abbrechen</a>
          </div>`,
      })}
    </form>`;
  return page(c, { title: 'CSV-Import', active: 'data', content }, status);
}

/** Reads token, mapping and options of the import form; null when the upload is gone. */
async function importState(c) {
  const form = await readForm(c);
  const token = form.text('token');
  const rows = /^[a-f0-9]{32}$/.test(token) ? loadUpload(token) : null;
  if (!rows) return null;
  const mapping = {};
  for (const field of importFields()) {
    const index = Number.parseInt(form.text(`map_${field.key}`), 10);
    if (Number.isInteger(index) && index >= 0 && index < rows[0].length) mapping[field.key] = index;
  }
  return { token, rows, mapping, updateExisting: form.has('update') };
}

dataRoutes.post('/import', async (c) => {
  const file = (await readForm(c)).files('file')[0];
  if (!file) return redirect(c, '/daten', 'Bitte eine CSV-Datei auswählen.', 'error');
  const { rows } = parseCsv(decodeCsv(Buffer.from(await file.arrayBuffer())));
  if (rows.length < 2) return redirect(c, '/daten', 'Die Datei enthält keine Datenzeilen (erwartet: Kopfzeile plus mindestens eine Zeile).', 'error');
  if (rows.length - 1 > MAX_ROWS) return redirect(c, '/daten', `Die Datei enthält mehr als ${MAX_ROWS} Zeilen. Bitte in mehrere Dateien aufteilen.`, 'error');
  if (rows[0].length > 200) return redirect(c, '/daten', 'Die Datei hat zu viele Spalten.', 'error');
  const token = stashUpload(rows);
  return importPage(c, { token, rows, mapping: autoMap(rows[0]), updateExisting: false });
});

dataRoutes.post('/import/pruefen', async (c) => {
  const state = await importState(c);
  if (!state) return redirect(c, '/daten', 'Der Upload ist abgelaufen. Bitte die Datei erneut hochladen.', 'error');
  return importPage(c, state);
});

dataRoutes.post('/import/ausfuehren', async (c) => {
  const state = await importState(c);
  if (!state) return redirect(c, '/daten', 'Der Upload ist abgelaufen. Bitte die Datei erneut hochladen.', 'error');
  const prepared = prepareImport(state.rows, state.mapping, state.updateExisting);
  if (prepared.create + prepared.update === 0) return importPage(c, state, 422);
  const result = runImport(prepared, c.get('user'));
  discardUpload(state.token);
  const parts = [`${result.created} neu angelegt`, `${result.updated} aktualisiert`];
  if (result.skipped > 0) parts.push(`${result.skipped} übersprungen`);
  return redirect(c, '/inventar?sort=created&dir=desc', `Import abgeschlossen: ${parts.join(', ')}.`);
});
