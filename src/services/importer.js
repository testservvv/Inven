// CSV import and export of the inventory. Export and import use the same
// column titles, so an exported file can be edited in Excel and read back in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { all, get, tx } from '../db.js';
import { ASSET_STATUS, OWNERSHIP } from '../lib/terms.js';
import { formatAmount, formatDate, parseDate } from '../lib/format.js';
import { unguard } from '../lib/csv.js';
import { createAsset, getAsset, nextInventoryNumber, updateAsset, validateAsset } from './assets.js';
import { ensureCategory, ensureLocation, ensurePolicy, listInspectionTypes } from './masterdata.js';
import { savePlan } from './inspections.js';
import { logEvent } from './events.js';

const normalize = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Importable columns. `aliases` are other titles commonly found in existing lists. */
const BASE_FIELDS = [
  { key: 'inventory_number', label: 'Inventarnummer', aliases: ['Inventar-Nr.', 'Inv.-Nr.', 'Inventarnr', 'Nummer', 'ID', 'Asset-ID'] },
  { key: 'name', label: 'Bezeichnung', aliases: ['Name', 'Gerät', 'Gegenstand', 'Artikel', 'Gerätename', 'Beschreibung'] },
  { key: 'category', label: 'Kategorie', aliases: ['Gruppe', 'Typ', 'Art', 'Geräteart'] },
  { key: 'manufacturer', label: 'Hersteller', aliases: ['Marke', 'Fabrikat'] },
  { key: 'model', label: 'Modell', aliases: ['Modell / Typ', 'Typenbezeichnung', 'Modellnummer'] },
  { key: 'serial_number', label: 'Seriennummer', aliases: ['Serien-Nr.', 'Seriennr', 'S/N', 'SN', 'Serial'] },
  { key: 'status', label: 'Status', aliases: [] },
  { key: 'location', label: 'Standort', aliases: ['Ort', 'Lagerort', 'Niederlassung', 'Gebäude'] },
  { key: 'location_detail', label: 'Raum / Platz', aliases: ['Raum', 'Platz', 'Zimmer', 'Büro'] },
  { key: 'assigned_to', label: 'Verantwortlich', aliases: ['Nutzer', 'Benutzer', 'Mitarbeiter', 'Zugewiesen an', 'Besitzer'] },
  { key: 'ownership', label: 'Eigentumsverhältnis', aliases: ['Eigentum'] },
  { key: 'purchase_date', label: 'Kaufdatum', aliases: ['Anschaffungsdatum', 'Gekauft am', 'Datum', 'Rechnungsdatum'] },
  { key: 'purchase_price', label: 'Anschaffungspreis', aliases: ['Preis', 'Kaufpreis', 'Anschaffungswert', 'Anschaffungskosten', 'Netto'] },
  { key: 'supplier', label: 'Lieferant', aliases: ['Händler', 'Bezugsquelle', 'Verkäufer'] },
  { key: 'invoice_number', label: 'Rechnungsnummer', aliases: ['Rechnungs-Nr.', 'Rechnung', 'Beleg', 'Belegnummer'] },
  { key: 'warranty_until', label: 'Garantie bis', aliases: ['Garantie', 'Garantieende', 'Gewährleistung bis'] },
  { key: 'policy', label: 'Versicherung', aliases: ['Police', 'Versicherungsvertrag'] },
  { key: 'insured_value', label: 'Versicherungswert', aliases: ['Neuwert', 'Wiederbeschaffungswert', 'Versicherungssumme'] },
  { key: 'notes', label: 'Notizen', aliases: ['Bemerkung', 'Bemerkungen', 'Kommentar', 'Anmerkung', 'Hinweis'] },
];

/** All importable fields, including one "next due" column per inspection type. */
export function importFields() {
  const planFields = listInspectionTypes().map((type) => ({
    key: `due:${type.id}`,
    label: `Fällig: ${type.name}`,
    aliases: [`Nächste ${type.name}`, `${type.name} fällig`, `${type.name} fällig am`, `${type.name} bis`],
    typeId: type.id,
    interval: type.default_interval_months,
  }));
  return [...BASE_FIELDS, ...planFields];
}

// --- Export -----------------------------------------------------------------
export function exportAssets(assets) {
  const fields = importFields();
  const plans = new Map();
  for (const plan of all('SELECT asset_id, type_id, next_due FROM inspection_plans')) {
    plans.set(`${plan.asset_id}:${plan.type_id}`, plan.next_due);
  }
  const value = (asset, field) => {
    switch (field.key) {
      case 'category': return asset.category_name;
      case 'location': return asset.location_name;
      case 'policy': return asset.policy_name;
      case 'status': return ASSET_STATUS[asset.status];
      case 'ownership': return OWNERSHIP[asset.ownership];
      case 'purchase_date':
      case 'warranty_until': return asset[field.key] ? formatDate(asset[field.key]) : '';
      case 'purchase_price': return formatAmount(asset.purchase_price_cents);
      case 'insured_value': return formatAmount(asset.insured_value_cents);
      default:
        if (field.typeId) {
          const due = plans.get(`${asset.id}:${field.typeId}`);
          return due ? formatDate(due) : '';
        }
        return asset[field.key];
    }
  };
  return [
    [...fields.map((field) => field.label), 'Offene Defekte'],
    ...assets.map((asset) => [...fields.map((field) => value(asset, field) ?? ''), asset.open_defects]),
  ];
}

export function templateRows() {
  const fields = importFields();
  const example = {
    inventory_number: 'INV-0001', name: 'Digitalmultimeter', category: 'Messtechnik', manufacturer: 'Fluke', model: '87V',
    serial_number: '12345678', status: 'In Betrieb', location: 'Werkstatt', location_detail: 'Schrank 2', assigned_to: 'Max Muster',
    ownership: 'Eigentum', purchase_date: '15.03.2024', purchase_price: '489,00', supplier: 'Conrad', invoice_number: 'RE-2024-0815',
    warranty_until: '15.03.2026', policy: 'Elektronikversicherung', insured_value: '520,00', notes: '',
  };
  return [fields.map((field) => field.label), fields.map((field) => example[field.key] ?? (field.typeId ? '15.03.2027' : ''))];
}

// --- Import: temporary storage of the uploaded file ---------------------------
const tokenFile = (token) => {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Ungültiges Import-Token');
  return path.join(paths.tmp, `import-${token}.json`);
};

export function stashUpload(rows) {
  // Forget uploads that were never finished.
  for (const name of fs.readdirSync(paths.tmp)) {
    const file = path.join(paths.tmp, name);
    if (name.startsWith('import-') && Date.now() - fs.statSync(file).mtimeMs > 2 * 3600_000) fs.rmSync(file, { force: true });
  }
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(tokenFile(token), JSON.stringify(rows), { mode: 0o600 });
  return token;
}

export function loadUpload(token) {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(token), 'utf8'));
  } catch {
    return null;
  }
}

export const discardUpload = (token) => fs.rmSync(tokenFile(token), { force: true });

/** Guesses which CSV column belongs to which field: { fieldKey: columnIndex }. */
export function autoMap(headers) {
  const mapping = {};
  const taken = new Set();
  const normalized = headers.map(normalize);
  for (const field of importFields()) {
    const names = [field.label, ...field.aliases].map(normalize);
    const index = normalized.findIndex((header, i) => !taken.has(i) && header && names.includes(header));
    if (index !== -1) {
      mapping[field.key] = index;
      taken.add(index);
    }
  }
  return mapping;
}

const lookup = (labels) => Object.fromEntries(Object.entries(labels).flatMap(([key, label]) => [[normalize(label), key], [normalize(key), key]]));
const STATUS_BY_NAME = { ...lookup(ASSET_STATUS), aktiv: 'active', lager: 'storage', defekt: 'repair', verlust: 'lost', gestohlen: 'lost' };
const OWNERSHIP_BY_NAME = { ...lookup(OWNERSHIP), gekauft: 'owned', geleast: 'leased', gemietet: 'rented', geliehen: 'loaned' };

/**
 * Validates every data row without writing anything.
 * @param {string[][]} rows    CSV rows including the header row
 * @param {object} mapping     { fieldKey: columnIndex }
 * @param {boolean} updateExisting  update devices whose inventory number already exists
 * @returns {{ items: object[], create: number, update: number, invalid: number }}
 */
export function prepareImport(rows, mapping, updateExisting) {
  const fields = importFields();
  const seen = new Set();
  const items = rows.slice(1).map((row, index) => {
    const cell = (key) => (mapping[key] === undefined ? '' : unguard(String(row[mapping[key]] ?? '').trim()));
    const errors = [];
    const number = cell('inventory_number');
    const existing = number ? get('SELECT id FROM assets WHERE inventory_number = ?', number) : null;

    if (number) {
      if (seen.has(number.toLowerCase())) errors.push('Inventarnummer kommt in der Datei mehrfach vor');
      seen.add(number.toLowerCase());
    }
    if (existing && !updateExisting) errors.push('Inventarnummer existiert bereits');

    // Updating keeps every value that the file leaves out or empty.
    const current = existing && updateExisting ? getAsset(existing.id) : null;
    const input = current
      ? { ...current, purchase_price: formatAmount(current.purchase_price_cents), insured_value: formatAmount(current.insured_value_cents) }
      : {};
    for (const field of BASE_FIELDS) {
      const value = cell(field.key);
      if (!value) continue;
      if (field.key === 'status') {
        input.status = STATUS_BY_NAME[normalize(value)];
        if (!input.status) errors.push(`Unbekannter Status „${value}“`);
      } else if (field.key === 'ownership') {
        input.ownership = OWNERSHIP_BY_NAME[normalize(value)];
        if (!input.ownership) errors.push(`Unbekanntes Eigentumsverhältnis „${value}“`);
      } else input[field.key] = value;
    }

    const { values, errors: fieldErrors } = validateAsset(input, { id: current?.id ?? null, autoNumber: false });
    if (!(existing && !updateExisting)) errors.push(...Object.values(fieldErrors));

    const plans = [];
    for (const field of fields.filter((item) => item.typeId)) {
      const value = cell(field.key);
      if (!value) continue;
      const nextDue = parseDate(value);
      if (!nextDue) errors.push(`${field.label}: „${value}“ ist kein Datum`);
      else plans.push({ typeId: field.typeId, intervalMonths: field.interval, nextDue });
    }

    return {
      line: index + 2,
      label: [number, input.name].filter(Boolean).join(' · ') || '(leer)',
      action: errors.length > 0 ? 'invalid' : current ? 'update' : 'create',
      errors,
      id: current?.id ?? null,
      values,
      names: { category: cell('category'), location: cell('location'), policy: cell('policy') },
      plans,
    };
  });
  const count = (action) => items.filter((item) => item.action === action).length;
  return { items, create: count('create'), update: count('update'), invalid: count('invalid') };
}

/** Writes all valid rows in one transaction. */
export function runImport(prepared, user) {
  return tx(() => {
    let created = 0;
    let updated = 0;
    for (const item of prepared.items) {
      if (item.action === 'invalid') continue;
      const references = {};
      // Only touch a reference when the file names one (an update keeps the rest).
      if (item.names.category) references.category_id = ensureCategory(item.names.category);
      if (item.names.location) references.location_id = ensureLocation(item.names.location);
      if (item.names.policy) references.policy_id = ensurePolicy(item.names.policy);

      let asset;
      if (item.action === 'update') {
        asset = updateAsset(item.id, { ...item.values, ...references }, user);
        updated++;
      } else {
        const values = { ...item.values, ...references, inventory_number: item.values.inventory_number ?? nextInventoryNumber() };
        asset = createAsset(values, user, { action: 'asset.imported' });
        created++;
      }
      for (const plan of item.plans) {
        // Keep an existing interval; the file only carries the due date.
        const existing = get('SELECT interval_months FROM inspection_plans WHERE asset_id = ? AND type_id = ?', asset.id, plan.typeId);
        savePlan(asset, plan.typeId, { intervalMonths: existing?.interval_months ?? plan.intervalMonths, nextDue: plan.nextDue }, user);
      }
    }
    logEvent({ user, action: 'import.completed', detail: `${created} neu, ${updated} aktualisiert, ${prepared.invalid} übersprungen` });
    return { created, updated, skipped: prepared.invalid };
  });
}
