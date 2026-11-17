// QR label sheets as PDF. A PDF keeps exact millimetre positions on every
// device and printer, which browser printing of HTML does not guarantee.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { qrMatrix } from './qr.js';

const MM = 72 / 25.4; // PDF points per millimetre
const A4 = { width: 210, height: 297 };

/**
 * Sizes in mm. Sheet formats describe an A4 grid (`left`/`top` = position of the
 * first label); roll formats are printed one label per page on a label printer.
 */
export const LABEL_FORMATS = [
  { id: 'a4-70x37', sheet: true, name: '70 × 37 mm · 24 pro Bogen', hint: 'z. B. Avery Zweckform 3474', cols: 3, rows: 8, width: 70, height: 37, left: 0, top: 0.5, gapX: 0, gapY: 0 },
  { id: 'a4-70x42', sheet: true, name: '70 × 42,3 mm · 21 pro Bogen', hint: 'z. B. Avery Zweckform 3652', cols: 3, rows: 7, width: 70, height: 42.3, left: 0, top: 0.45, gapX: 0, gapY: 0 },
  { id: 'a4-63x38', sheet: true, name: '63,5 × 38,1 mm · 21 pro Bogen', hint: 'z. B. Avery L7160', cols: 3, rows: 7, width: 63.5, height: 38.1, left: 7.21, top: 15.15, gapX: 2.54, gapY: 0 },
  { id: 'a4-52x30', sheet: true, name: '52,5 × 29,7 mm · 40 pro Bogen', hint: 'z. B. Avery Zweckform 3651', cols: 4, rows: 10, width: 52.5, height: 29.7, left: 0, top: 0, gapX: 0, gapY: 0 },
  { id: 'a4-48x25', sheet: true, name: '48,5 × 25,4 mm · 40 pro Bogen', hint: 'z. B. Avery Zweckform 3657', cols: 4, rows: 10, width: 48.5, height: 25.4, left: 8, top: 21.5, gapX: 0, gapY: 0 },
  { id: 'a4-38x21', sheet: true, name: '38,1 × 21,2 mm · 65 pro Bogen', hint: 'z. B. Avery L7651', cols: 5, rows: 13, width: 38.1, height: 21.2, left: 4.75, top: 10.7, gapX: 2.5, gapY: 0 },
  { id: 'roll-62x29', sheet: false, name: '62 × 29 mm', hint: 'z. B. Brother DK-11209', width: 62, height: 29 },
  { id: 'roll-57x32', sheet: false, name: '57 × 32 mm', hint: 'z. B. Dymo 11354', width: 57, height: 32 },
  { id: 'roll-54x25', sheet: false, name: '54 × 25 mm', hint: 'z. B. Dymo 11352', width: 54, height: 25 },
  { id: 'roll-89x36', sheet: false, name: '89 × 36 mm', hint: 'z. B. Dymo 99012', width: 89, height: 36 },
  { id: 'roll-50x30', sheet: false, name: '50 × 30 mm', hint: 'Thermo-Etikett', width: 50, height: 30 },
  { id: 'roll-30x30', sheet: false, name: '30 × 30 mm', hint: 'quadratisch, nur QR-Code und Nummer', width: 30, height: 30 },
];

export const DEFAULT_FORMAT = 'a4-70x37';
export const MAX_LABELS = 2000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function number(raw, fallback, min, max) {
  const value = Number.parseFloat(String(raw ?? '').replace(',', '.'));
  return Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

/**
 * Turns request parameters into a validated format. "custom-sheet" and
 * "custom-roll" take their geometry from the parameters, presets ignore them.
 */
export function resolveFormat(params) {
  const id = params.format;
  if (id === 'custom-roll') {
    return { id, sheet: false, name: 'Eigenes Format', width: number(params.width, 62, 10, 210), height: number(params.height, 29, 8, 297) };
  }
  if (id === 'custom-sheet') {
    const cols = Math.round(number(params.cols, 3, 1, 12));
    const rows = Math.round(number(params.rows, 8, 1, 40));
    return {
      id,
      sheet: true,
      name: 'Eigener A4-Bogen',
      cols,
      rows,
      width: number(params.width, 70, 10, A4.width),
      height: number(params.height, 37, 8, A4.height),
      left: number(params.left, 0, 0, 100),
      top: number(params.top, 0, 0, 100),
      gapX: number(params.gapX, 0, 0, 30),
      gapY: number(params.gapY, 0, 0, 30),
    };
  }
  return LABEL_FORMATS.find((format) => format.id === id) ?? LABEL_FORMATS.find((format) => format.id === DEFAULT_FORMAT);
}

// The built-in PDF fonts only cover Windows-1252. Common technical symbols are
// spelled out, anything else becomes "?" instead of failing the whole export.
const REPLACEMENTS = {
  'Ω': 'Ohm', // Greek capital omega
  'Ω': 'Ohm', // ohm sign
  'μ': 'µ', // Greek mu → micro sign
  '≤': '<=',
  '≥': '>=',
  '→': '->',
  '←': '<-',
  '≈': '~',
  '−': '-', // minus sign
  '‑': '-', // non-breaking hyphen
  '″': '"',
  '′': "'",
  'ẞ': 'SS',
};

function printable(text, charset) {
  let out = '';
  for (const char of String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()) {
    out += charset.has(char.codePointAt(0)) ? char : (REPLACEMENTS[char] ?? '?');
  }
  return out;
}

function truncate(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Greedy word wrap into at most `maxLines` lines; the last line is truncated with an ellipsis. */
function wrap(font, text, size, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  const words = text.split(' ');
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      lines.push(truncate(font, [line, ...words.slice(i)].filter(Boolean).join(' '), size, maxWidth));
      return lines;
    }
    if (line) lines.push(line);
    line = words[i];
    // A single word wider than the label is cut rather than overflowing.
    if (font.widthOfTextAtSize(line, size) > maxWidth) line = truncate(font, line, size, maxWidth);
  }
  if (line) lines.push(line);
  return lines;
}

function drawQr(page, text, x, top, size) {
  const { size: modules, path } = qrMatrix(text);
  const quiet = 2; // modules of white space; the label itself adds more
  const scale = size / (modules + quiet * 2);
  // One filled path for the whole code avoids hairline gaps between modules.
  page.drawSvgPath(path, { x: x + quiet * scale, y: top - quiet * scale, scale, color: rgb(0, 0, 0), borderWidth: 0 });
}

/**
 * Draws one label. (x, top) is the label's top-left corner in PDF points with
 * the usual PDF orientation (y grows upwards).
 */
function drawLabel(page, fonts, item, footer, x, top, width, height) {
  const pad = clamp(Math.min(width, height) * 0.07, 1.5 * MM, 3 * MM);
  const black = rgb(0, 0, 0);
  const grey = rgb(0.35, 0.35, 0.35);
  const lineHeight = 1.18;
  const ascent = 0.74; // Helvetica cap height relative to the font size

  if (width >= height * 1.5) {
    // Wide label: QR code on the left, text block on the right.
    const qr = height - pad * 2;
    drawQr(page, item.url, x + pad, top - pad, qr);
    const textX = x + pad + qr + pad * 0.8;
    const textWidth = x + width - pad - textX;
    if (textWidth < 8 * MM) return;

    let numberSize = clamp(height * 0.16, 6.5, 13);
    while (numberSize > 5.5 && fonts.bold.widthOfTextAtSize(item.number, numberSize) > textWidth) numberSize -= 0.5;
    const nameSize = clamp(height * 0.115, 5.5, 9.5);
    const footerSize = clamp(height * 0.09, 4.5, 7);

    const footerHeight = footer ? footerSize * lineHeight + pad * 0.3 : 0;
    const available = height - pad * 2 - footerHeight;
    const numberHeight = numberSize * lineHeight;
    const maxNameLines = clamp(Math.floor((available - numberHeight) / (nameSize * lineHeight)), 0, 3);
    const nameLines = item.title && maxNameLines > 0 ? wrap(fonts.regular, item.title, nameSize, textWidth, maxNameLines) : [];

    const blockHeight = numberHeight + nameLines.length * nameSize * lineHeight;
    let y = top - pad - Math.max(0, (available - blockHeight) / 2);
    page.drawText(truncate(fonts.bold, item.number, numberSize, textWidth), { x: textX, y: y - numberSize * ascent, size: numberSize, font: fonts.bold, color: black });
    y -= numberHeight;
    for (const line of nameLines) {
      page.drawText(line, { x: textX, y: y - nameSize * ascent, size: nameSize, font: fonts.regular, color: black });
      y -= nameSize * lineHeight;
    }
    if (footer) {
      page.drawText(truncate(fonts.regular, footer, footerSize, textWidth), { x: textX, y: top - height + pad + footerSize * 0.2, size: footerSize, font: fonts.regular, color: grey });
    }
    return;
  }

  // Narrow or square label: QR code on top, inventory number centred below.
  const numberSize = clamp(Math.min(width, height) * 0.13, 5.5, 11);
  const textHeight = numberSize * lineHeight;
  const qr = Math.min(width - pad * 2, height - pad * 2 - textHeight);
  drawQr(page, item.url, x + (width - qr) / 2, top - pad, qr);
  const text = truncate(fonts.bold, item.number, numberSize, width - pad * 2);
  const textWidth = fonts.bold.widthOfTextAtSize(text, numberSize);
  page.drawText(text, { x: x + (width - textWidth) / 2, y: top - pad - qr - numberSize * ascent - numberSize * 0.12, size: numberSize, font: fonts.bold, color: black });
}

/**
 * @param {object} options
 * @param {object} options.format   result of resolveFormat()
 * @param {{url: string, number: string, title?: string}[]} options.items
 * @param {string} [options.footer] small grey line, e.g. "Eigentum der Muster GmbH"
 * @param {number} [options.skip]   label positions to leave empty on the first sheet
 * @param {number} [options.offsetX] fine adjustment in mm (positive = right)
 * @param {number} [options.offsetY] fine adjustment in mm (positive = down)
 * @param {boolean} [options.outline] draw label borders (for a test print on plain paper)
 * @returns {Promise<Uint8Array>}
 */
export async function renderLabels({ format, items, footer = '', skip = 0, offsetX = 0, offsetY = 0, outline = false }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Inventar-Etiketten');
  pdf.setCreator('Inventar');
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const charset = new Set(fonts.regular.getCharacterSet());
  const labels = items.slice(0, MAX_LABELS).map((item) => ({
    url: item.url,
    number: printable(item.number, charset),
    title: printable(item.title, charset),
  }));
  const footerText = printable(footer, charset);
  const width = format.width * MM;
  const height = format.height * MM;
  const border = { borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.4 };

  if (!format.sheet) {
    for (const label of labels) {
      const page = pdf.addPage([width, height]);
      drawLabel(page, fonts, label, footerText, 0, height, width, height);
    }
    if (labels.length === 0) pdf.addPage([width, height]);
    return pdf.save();
  }

  const perPage = format.cols * format.rows;
  let position = clamp(Math.round(skip) || 0, 0, perPage - 1);
  let page = null;
  for (const label of labels) {
    if (!page || position >= perPage) {
      page = pdf.addPage([A4.width * MM, A4.height * MM]);
      if (position >= perPage) position = 0;
    }
    const col = position % format.cols;
    const row = Math.floor(position / format.cols);
    const x = (format.left + col * (format.width + format.gapX) + offsetX) * MM;
    const top = (A4.height - format.top - row * (format.height + format.gapY) - offsetY) * MM;
    if (outline) page.drawRectangle({ x, y: top - height, width, height, ...border });
    drawLabel(page, fonts, label, footerText, x, top, width, height);
    position++;
  }
  if (!page) pdf.addPage([A4.width * MM, A4.height * MM]);
  return pdf.save();
}
