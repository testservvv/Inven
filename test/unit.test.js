// Unit tests for the helper libraries (no database, no HTTP).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { addDays, addMonths, daysBetween, formatAmount, formatDate, formatMoney, parseDate, parseMoney } from '../src/lib/format.js';
import { hashPassword, needsRehash, passwordProblem, safeEqual, temporaryPassword, verifyPassword } from '../src/lib/security.js';
import { base32Decode, base32Encode, generateSecret, hashRecoveryCode, hotp, otpauthUrl, totp, verifyTotp } from '../src/lib/totp.js';
import { decodeCsv, parseCsv, toCsv, unguard } from '../src/lib/csv.js';
import { qrMatrix, qrSvg } from '../src/lib/qr.js';
import { LABEL_FORMATS, renderLabels, resolveFormat } from '../src/lib/labels.js';
import { sniffType } from '../src/lib/uploads.js';

test('dates: parsing, month arithmetic and formatting', () => {
  assert.equal(parseDate('31.03.2026'), '2026-03-31');
  assert.equal(parseDate('1.3.26'), '2026-03-01');
  assert.equal(parseDate('2026-03-31'), '2026-03-31');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('31.02.2026'), undefined);
  assert.equal(parseDate('morgen'), undefined);
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2026-11-16', 12), '2027-11-16');
  assert.equal(addMonths('2026-03-15', -4), '2025-11-15');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59);
  assert.equal(formatDate('2026-11-16'), '16.11.2026');
});

test('money: German and English notation', () => {
  assert.equal(parseMoney('1.249,00'), 124900);
  assert.equal(parseMoney('1249,5'), 124950);
  assert.equal(parseMoney('1249.50'), 124950);
  assert.equal(parseMoney('1.249'), 124900);
  assert.equal(parseMoney('12.5'), 1250);
  assert.equal(parseMoney('1 249 €'), 124900);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), undefined);
  assert.equal(parseMoney('-5'), undefined);
  assert.equal(parseMoney('0,999'), undefined);
  assert.equal(formatAmount(124950), '1.249,50');
  assert.match(formatMoney(124900), /^1\.249,00\s€$/);
});

test('passwords: hashing, verification and policy', async () => {
  const hash = await hashPassword('Korrekt-Pferd-Batterie');
  assert.match(hash, /^scrypt\$15\$8\$3\$/);
  assert.equal(await verifyPassword('Korrekt-Pferd-Batterie', hash), true);
  assert.equal(await verifyPassword('korrekt-pferd-batterie', hash), false);
  assert.equal(await verifyPassword('x', 'kein-hash'), false);
  assert.equal(needsRehash(hash), false);
  assert.equal(needsRehash('scrypt$14$8$1$a$b'), true);
  assert.notEqual(await hashPassword('Korrekt-Pferd-Batterie'), hash, 'salt must differ');

  const who = { username: 'maxmuster', name: 'Max Muster' };
  for (const weak of ['kurz', 'Passwort2026!', '1234567890', 'qwertz12345', 'aaaaaaaaaaaa', 'maxmuster-99x', 'Willkommen123']) {
    assert.ok(passwordProblem(weak, who), `${weak} should be rejected`);
  }
  assert.equal(passwordProblem('Tisch-Lampe-42-blau', who), null);
  assert.equal(passwordProblem(temporaryPassword(), who), null);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('TOTP matches the RFC 6238 test vectors', () => {
  const key = Buffer.from('12345678901234567890');
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [time, code] of vectors) assert.equal(hotp(key, Math.floor(time / 30), 8), code);
});

test('TOTP: verification window, replay protection, Base32', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('mzxw 6ytb oi').toString(), 'foobar');
  assert.throws(() => base32Decode('1!'));

  const secret = generateSecret();
  const time = 1_800_000_000_000;
  const step = Math.floor(time / 30000);
  assert.equal(verifyTotp(secret, totp(secret, time), { time }), step);
  assert.equal(verifyTotp(secret, totp(secret, time - 30000), { time }), step - 1, 'previous step is accepted');
  assert.equal(verifyTotp(secret, totp(secret, time - 90000), { time }), null, 'old codes are rejected');
  assert.equal(verifyTotp(secret, totp(secret, time), { time, afterStep: step }), null, 'a used code cannot be replayed');
  assert.equal(verifyTotp(secret, '12345', { time }), null);
  assert.equal(verifyTotp(secret, 'abcdef', { time }), null);
  assert.match(otpauthUrl({ issuer: 'Muster GmbH', account: 'a@b.de', secret }), /^otpauth:\/\/totp\/Muster%20GmbH:a%40b\.de\?secret=[A-Z2-7]{32}&issuer=Muster%20GmbH/);
  assert.equal(hashRecoveryCode('abcde-fghij'), hashRecoveryCode(' ABCDE FGHIJ '));
});

test('CSV: round trip, Excel quirks and formula guard', () => {
  const rows = [['Name', 'Wert', 'Notiz'], ['Oszi "Rigol"; DS1054', '1.249,00', 'Zeile 1\nZeile 2'], ['=SUMME(A1)', '-5', '@x']];
  const text = toCsv(rows);
  assert.ok(text.startsWith('﻿'));
  const parsed = parseCsv(text);
  assert.equal(parsed.delimiter, ';');
  assert.deepEqual(parsed.rows[1], rows[1]);
  assert.deepEqual(parsed.rows[2], ["'=SUMME(A1)", '-5', "'@x"], 'formulas are neutralised, plain numbers are not');
  assert.equal(unguard("'=SUMME(A1)"), '=SUMME(A1)');
  assert.equal(unguard("'s Gravenhage"), "'s Gravenhage");

  assert.deepEqual(parseCsv('a,b,c\r\n1,"x,y",3\r\n\r\n').rows, [['a', 'b', 'c'], ['1', 'x,y', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
  assert.equal(decodeCsv(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72])), 'Müller', 'Windows-1252 fallback');
  assert.equal(decodeCsv(Buffer.from('Müller', 'utf8')), 'Müller');
});

test('QR codes and label PDFs', async () => {
  const { size, path } = qrMatrix('https://inventar.example.de/q/ABCD2345');
  assert.ok(size >= 21 && path.startsWith('M'));
  assert.match(qrSvg('x'), /^<svg[^>]+viewBox="0 0 \d+ \d+"/);

  const items = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.de/q/A${i}`, number: `INV-${i}`, title: 'Widerstandsdekade 10 kΩ 😀' }));
  const sheet = await PDFDocument.load(await renderLabels({ format: resolveFormat({ format: 'a4-70x37' }), items, footer: 'Muster GmbH', skip: 2 }));
  assert.equal(sheet.getPageCount(), 2, '30 labels + 2 skipped on 24-up sheets');
  const roll = await PDFDocument.load(await renderLabels({ format: resolveFormat({ format: 'roll-62x29' }), items: items.slice(0, 3) }));
  assert.equal(roll.getPageCount(), 3);
  assert.equal(Math.round(roll.getPage(0).getWidth() / (72 / 25.4)), 62);

  for (const format of LABEL_FORMATS.filter((item) => item.sheet)) {
    assert.ok(format.left + format.cols * format.width + (format.cols - 1) * format.gapX <= 210.01, `${format.id} fits A4 width`);
    assert.ok(format.top + format.rows * format.height + (format.rows - 1) * format.gapY <= 297.01, `${format.id} fits A4 height`);
  }
  assert.equal(resolveFormat({ format: 'unbekannt' }).id, 'a4-70x37');
  assert.equal(resolveFormat({ format: 'custom-roll', width: '9999', height: '25,5' }).width, 210);
  assert.equal(resolveFormat({ format: 'custom-roll', width: '50', height: '25,5' }).height, 25.5);
});

test('uploads are recognised by content, not by name', () => {
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).mime, 'image/png');
  assert.equal(sniffType(Buffer.from('%PDF-1.7 ...')).mime, 'application/pdf');
  assert.equal(sniffType(Buffer.from('<svg onload="alert(1)">')), null);
  assert.equal(sniffType(Buffer.from('<html><script>')), null);
  assert.equal(sniffType(Buffer.from('MZ\x90\x00')), null);
});
