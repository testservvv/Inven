// Password hashing, random tokens and constant-time comparison. Uses node:crypto only.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt N=2^15, r=8, p=3 – one of the parameter sets OWASP lists as equivalent
// to its recommended minimum (≈32 MiB of memory per hash).
const SCRYPT = { logN: 15, r: 8, p: 3, keyLength: 32 };

function derive(password, salt, { logN, r, p, keyLength }) {
  const N = 2 ** logN;
  return scrypt(password.normalize('NFKC'), salt, keyLength, { N, r, p, maxmem: 256 * N * r });
}

/** Returns "scrypt$logN$r$p$salt$hash" so parameters can be raised later without breaking logins. */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.logN, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password, stored) {
  const fields = String(stored ?? '').split('$');
  if (fields.length !== 6 || fields[0] !== 'scrypt') return false;
  const [logN, r, p] = fields.slice(1, 4).map(Number);
  if (!(logN >= 10 && logN <= 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const expected = Buffer.from(fields[5], 'base64url');
  if (expected.length < 16) return false;
  const key = await derive(password, Buffer.from(fields[4], 'base64url'), { logN, r, p, keyLength: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

export function needsRehash(stored) {
  const [scheme, logN, r, p] = String(stored ?? '').split('$');
  return scheme !== 'scrypt' || Number(logN) !== SCRYPT.logN || Number(r) !== SCRYPT.r || Number(p) !== SCRYPT.p;
}

// Verifying against a throwaway hash keeps the response time identical for
// unknown usernames, so the login form does not reveal which accounts exist.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword(crypto.randomBytes(18).toString('base64url'));
  await verifyPassword(password, await dummyHash);
  return false;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Letters and digits that cannot be confused when read aloud or typed (no 0/O, 1/I/L). */
export const CLEAR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function randomString(length, alphabet = CLEAR_ALPHABET) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

/** One-time password an admin hands to a user, e.g. "K7MQ-P4TW-N9CZ-R2HX" (≈79 bits). */
export function temporaryPassword() {
  return [0, 1, 2, 3].map(() => randomString(4)).join('-');
}

// --- Password policy --------------------------------------------------------
// Length plus a block list instead of composition rules (NIST SP 800-63B).
export const PASSWORD_MIN_LENGTH = 10;

const COMMON_WORDS = new Set([
  'passwort', 'password', 'passwd', 'kennwort', 'geheim', 'willkommen', 'welcome', 'hallo', 'hello',
  'admin', 'administrator', 'login', 'start', 'test', 'testtest', 'inventar', 'inventory', 'qwertz',
  'qwerty', 'qwertzuiop', 'qwertyuiop', 'asdfghjkl', 'abcdefghij', 'iloveyou', 'ichliebedich',
  'sommer', 'winter', 'fruehling', 'frühling', 'herbst', 'changeme', 'letmein', 'computer', 'firma',
  'schalke', 'dortmund', 'bayern', 'fussball', 'fußball', 'sonnenschein', 'schatz', 'master', 'dragon',
  'monkey', 'superman', 'internet', 'passw', 'pass', 'qwe', 'qweasd', 'qweasdzxc', 'qwer', 'asdf',
]);

const SEQUENCES = ['01234567890', '09876543210', 'abcdefghijklmnopqrstuvwxyz', 'qwertzuiopasdfghjklyxcvbnm', 'qwertyuiopasdfghjklzxcvbnm'];

function isSequence(text) {
  return text.length >= 6 && SEQUENCES.some((sequence) => sequence.includes(text));
}

/** Returns a German error message, or null when the password is acceptable. */
export function passwordProblem(password, { username = '', name = '' } = {}) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Das Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen lang sein.`;
  }
  if (password.length > 200) return 'Das Passwort darf höchstens 200 Zeichen lang sein.';

  const lower = password.toLowerCase();
  if (new Set(lower).size < 5) return 'Das Passwort ist zu einfach – bitte mehr unterschiedliche Zeichen verwenden.';

  const letters = lower.replace(/[^a-zäöüß]/g, '');
  const rest = lower.replace(/[a-zäöüß]/g, '');
  const trivialRest = rest === '' || /^[\d!?.#*_\-+@$%&]*$/.test(rest);
  if (trivialRest && (COMMON_WORDS.has(letters) || isSequence(letters) || (letters === '' && isSequence(rest)))) {
    return 'Dieses Passwort ist zu leicht zu erraten. Bitte ein anderes wählen.';
  }
  if (isSequence(lower)) return 'Dieses Passwort ist zu leicht zu erraten. Bitte ein anderes wählen.';

  const personal = [username, ...name.split(/\s+/)].map((part) => part.toLowerCase()).filter((part) => part.length >= 4);
  if (personal.some((part) => lower.includes(part))) {
    return 'Das Passwort darf weder den Benutzernamen noch den eigenen Namen enthalten.';
  }
  return null;
}
