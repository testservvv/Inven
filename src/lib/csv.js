// Minimal CSV reader/writer (RFC 4180) that copes with what Excel produces in
// German locales: semicolons, a UTF-8 BOM or Windows-1252 encoding, CRLF.

/** Decodes an uploaded file: UTF-8 (with or without BOM), UTF-16 LE, else Windows-1252. */
export function decodeCsv(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function detectDelimiter(text) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** Returns all non-empty rows as arrays of trimmed strings. */
export function parseCsv(input, delimiter) {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (char === separator) endField();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else field += char;
  }
  if (field !== '' || row.length > 0) endRow();
  return { delimiter: separator, rows };
}

// Spreadsheet programs execute cells that start with = + - @ as formulas. A
// leading apostrophe forces such cells to be read as text ("CSV injection").
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value, delimiter) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) text = `'${text}`;
  return text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Undo the apostrophe added by `toCsv` when a file is imported again. */
export const unguard = (value) => (/^'[=+\-@]/.test(value) ? value.slice(1) : value);

/** Serialises rows with a BOM and CRLF line ends so Excel opens the file correctly. */
export function toCsv(rows, delimiter = ';') {
  return `﻿${rows.map((row) => row.map((value) => cell(value, delimiter)).join(delimiter)).join('\r\n')}\r\n`;
}
