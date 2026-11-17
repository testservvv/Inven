// Minimal tar (POSIX ustar) writer and streaming reader for backup archives.
// Only regular files with short names are needed, which keeps this small; the
// output opens with every common tool (tar, 7-Zip, Windows Explorer, macOS).
import fs from 'node:fs';
import { Writable } from 'node:stream';

const BLOCK = 512;
const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`;

export function tarHeader(name, size, mtimeMs = Date.now()) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Dateiname zu lang für das Archiv: ${name}`);
  if (size > 0o77777777777) throw new Error(`Datei zu groß für das Archiv: ${name}`);
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(octal(0o644, 8), 100, 'ascii'); // mode
  header.write(octal(0, 8), 108, 'ascii'); // uid
  header.write(octal(0, 8), 116, 'ascii'); // gid
  header.write(octal(size, 12), 124, 'ascii');
  header.write(octal(Math.floor(mtimeMs / 1000), 12), 136, 'ascii');
  header.write('        ', 148, 'ascii'); // checksum placeholder (spaces)
  header.write('0', 156, 'ascii'); // regular file
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${octal(sum, 7)} `, 148, 'ascii');
  return header;
}

/**
 * Yields the bytes of a tar archive. Entries are either in memory
 * ({ name, data }) or read from disk ({ name, path }). Files that vanished
 * before they were reached are skipped.
 */
export async function* tarStream(entries) {
  for (const entry of entries) {
    if (entry.data) {
      yield tarHeader(entry.name, entry.data.length);
      yield entry.data;
      yield padding(entry.data.length);
      continue;
    }
    let handle;
    try {
      handle = await fs.promises.open(entry.path, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const { size, mtimeMs } = await handle.stat();
      yield tarHeader(entry.name, size, mtimeMs);
      let written = 0;
      while (written < size) {
        const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, size - written));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, written);
        if (bytesRead === 0) {
          // The file shrank while reading: fill up so the archive stays valid.
          yield Buffer.alloc(size - written);
          break;
        }
        yield chunk.subarray(0, bytesRead);
        written += bytesRead;
      }
      yield padding(size);
    } finally {
      await handle.close();
    }
  }
  yield Buffer.alloc(BLOCK * 2); // end-of-archive marker
}

function field(header, start, length) {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

function parseHeader(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  const stored = Number.parseInt(field(header, 148, 8).trim(), 8);
  if (stored !== sum) throw new Error('Ungültiger Archiv-Header (Prüfsumme)');
  if (header[124] & 0x80) throw new Error('Nicht unterstütztes Größenformat im Archiv');
  const size = Number.parseInt(field(header, 124, 12).trim() || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Ungültige Dateigröße im Archiv');
  const prefix = field(header, 345, 155);
  const name = field(header, 0, 100);
  const flag = String.fromCharCode(header[156]);
  return { name: prefix ? `${prefix}/${name}` : name, size, type: flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'directory' : 'other' };
}

/**
 * Writable stream that unpacks a tar archive. For every regular file it calls
 * `open(name, size)`, which returns a file descriptor to write the content to,
 * or null to skip the entry. `open` may throw to abort the extraction.
 */
export class TarExtractor extends Writable {
  #open;
  #pending = Buffer.alloc(0);
  #state = 'header';
  #remaining = 0;
  #padding = 0;
  #fd = null;
  #ended = false;

  constructor({ open }) {
    super();
    this.#open = open;
  }

  _write(chunk, _encoding, callback) {
    try {
      this.#consume(chunk);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    callback(this.#ended ? null : new Error('Das Archiv ist unvollständig.'));
  }

  _destroy(error, callback) {
    this.#closeFile();
    callback(error);
  }

  #closeFile() {
    if (this.#fd !== null) fs.closeSync(this.#fd);
    this.#fd = null;
  }

  #finishEntry() {
    this.#closeFile();
    this.#state = this.#padding > 0 ? 'padding' : 'header';
  }

  #consume(chunk) {
    if (this.#ended) return;
    const buffer = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    let offset = 0;
    while (offset < buffer.length && !this.#ended) {
      if (this.#state === 'header') {
        if (buffer.length - offset < BLOCK) break;
        const header = buffer.subarray(offset, offset + BLOCK);
        offset += BLOCK;
        if (header.every((byte) => byte === 0)) {
          this.#ended = true;
          break;
        }
        const entry = parseHeader(header);
        this.#remaining = entry.size;
        this.#padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
        this.#fd = entry.type === 'file' ? this.#open(entry.name, entry.size) : null;
        this.#state = 'data';
        if (this.#remaining === 0) this.#finishEntry();
      } else if (this.#state === 'data') {
        const take = Math.min(this.#remaining, buffer.length - offset);
        let done = 0;
        while (this.#fd !== null && done < take) done += fs.writeSync(this.#fd, buffer, offset + done, take - done);
        offset += take;
        this.#remaining -= take;
        if (this.#remaining === 0) this.#finishEntry();
      } else {
        const take = Math.min(this.#padding, buffer.length - offset);
        offset += take;
        this.#padding -= take;
        if (this.#padding === 0) this.#state = 'header';
      }
    }
    // Only an incomplete header (< 512 bytes) can be left over.
    this.#pending = this.#ended ? Buffer.alloc(0) : Buffer.from(buffer.subarray(offset));
  }
}
