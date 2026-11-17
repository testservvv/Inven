// Date, money and text helpers. Dates are plain "YYYY-MM-DD" strings, money is integer cents.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;

/** Today's date in the server's time zone. */
export function today() {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function parts(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

function isRealDate(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Accepts "2026-03-31", "31.03.2026" and "31.3.26".
 * Returns an ISO date, null for empty input, or undefined when the input is not a date.
 */
export function parseDate(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  let y;
  let m;
  let d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text);
    if (!match) return undefined;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (match[3].length === 2) y += 2000;
  }
  return isRealDate(y, m, d) ? iso(y, m, d) : undefined;
}

/** Adds calendar months, clamping to the last day of the month (31 Jan + 1 → 28/29 Feb). */
export function addMonths(date, months) {
  const { y, m, d } = parts(date);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(year, month + 1, Math.min(d, lastDay));
}

export function addDays(date, days) {
  const { y, m, d } = parts(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export function formatDate(date) {
  if (!date) return '–';
  const { y, m, d } = parts(date.slice(0, 10));
  return `${pad(d)}.${pad(m)}.${y}`;
}

const dateTime = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

/** Formats a UTC timestamp (ISO string) in local time, e.g. "16.11.2026, 14:32". */
export function formatDateTime(timestamp) {
  if (!timestamp) return '–';
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? '–' : dateTime.format(d);
}

export function formatTimestampDate(timestamp) {
  if (!timestamp) return '–';
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? '–' : dateOnly.format(d);
}

/** "heute", "in 12 Tagen", "seit 3 Tagen" – relative to today. */
export function relativeDays(date, reference = today()) {
  const days = daysBetween(reference, date);
  if (days === 0) return 'heute';
  if (days === 1) return 'morgen';
  if (days === -1) return 'seit gestern';
  if (days > 0) return days < 60 ? `in ${days} Tagen` : `in ${Math.round(days / 30.4)} Monaten`;
  return -days < 60 ? `seit ${-days} Tagen` : `seit ${Math.round(-days / 30.4)} Monaten`;
}

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const plainNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatMoney(cents) {
  return cents === null || cents === undefined ? '–' : euro.format(cents / 100);
}

/** "1.249,00" – for form fields and CSV cells (no currency sign). */
export function formatAmount(cents) {
  return cents === null || cents === undefined ? '' : plainNumber.format(cents / 100);
}

/**
 * Parses "1.249,00", "1249,5", "1249.50", "1 249 €" into cents.
 * Returns null for empty input and undefined for anything that is not an amount.
 */
export function parseMoney(input) {
  let text = String(input ?? '').replace(/[\s€'’]|EUR/gi, '');
  if (!text) return null;
  if (!/^\d[\d.,]*$/.test(text)) return undefined;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the later one is the decimal separator.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // German notation: a lone comma is always the decimal separator.
    text = text.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    // German thousands separators only: "1.249" means 1249.
    text = text.replace(/\./g, '');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return undefined;
  const cents = Math.round(Number(text) * 100);
  return cents <= 99_999_999_999 ? cents : undefined;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Trims, collapses inner whitespace runs and caps the length; returns '' for missing values. */
export function cleanText(value, maxLength = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}
