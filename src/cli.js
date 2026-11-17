#!/usr/bin/env node
// Maintenance commands for situations the web interface cannot solve,
// e.g. when the only administrator has lost the password.
//
//   node src/cli.js nutzer                      list accounts
//   node src/cli.js passwort <benutzername>     set a new temporary password
//   node src/cli.js 2fa-entfernen <benutzername>
//   node src/cli.js admin <benutzername>        make the account an active administrator
//   node src/cli.js backup                      write a database snapshot now
//   node src/cli.js sicherung-erstellen <datei|->  complete backup (.tar.gz), "-" = stdout
import { db, run } from './db.js';
import { destroyAllSessions, disableTotp, unlockUser } from './services/auth.js';
import { snapshot } from './services/backup.js';
import { writeArchive } from './services/transfer.js';
import { findUserByUsername, listUsers, setPassword } from './services/users.js';
import { temporaryPassword } from './lib/security.js';
import { ROLE } from './lib/terms.js';

const [command, username] = process.argv.slice(2);

function requireUser() {
  const user = username ? findUserByUsername(username) : null;
  if (!user) {
    console.error(username ? `Kein Nutzer mit dem Benutzernamen „${username}“ gefunden.` : 'Bitte einen Benutzernamen angeben.');
    process.exit(1);
  }
  return user;
}

switch (command) {
  case 'nutzer':
    for (const user of listUsers()) {
      console.log(`${user.username.padEnd(32)} ${ROLE[user.role].padEnd(14)} ${user.active ? 'aktiv' : 'deaktiviert'}${user.totp_enabled ? ' · 2FA' : ''}  (${user.name})`);
    }
    break;
  case 'passwort': {
    const user = requireUser();
    const password = temporaryPassword();
    await setPassword(user.id, password, { mustChangePassword: true });
    destroyAllSessions(user.id);
    unlockUser(user.username);
    console.log(`Neues vorläufiges Passwort für ${user.username}: ${password}`);
    console.log('Beim nächsten Anmelden muss ein eigenes Passwort festgelegt werden.');
    break;
  }
  case '2fa-entfernen': {
    const user = requireUser();
    disableTotp(user.id);
    console.log(`Zwei-Faktor-Schutz für ${user.username} wurde entfernt.`);
    break;
  }
  case 'admin': {
    const user = requireUser();
    run("UPDATE users SET role = 'admin', active = 1 WHERE id = ?", user.id);
    console.log(`${user.username} ist jetzt aktiver Administrator.`);
    break;
  }
  case 'backup':
    console.log(`Sicherung geschrieben: ${await snapshot({ force: true })}`);
    break;
  case 'sicherung-erstellen': {
    if (!username) {
      console.error('Bitte eine Zieldatei angeben, oder „-“ für die Standardausgabe.');
      process.exit(1);
    }
    const manifest = await writeArchive(username);
    // Messages go to stderr so that "-" (stdout) stays a clean archive.
    console.error(`Komplettsicherung erstellt: ${manifest.counts.assets} Geräte, ${manifest.counts.users} Nutzer, ${manifest.counts.attachments} Dateien.`);
    break;
  }
  default:
    console.log('Befehle: nutzer | passwort <benutzername> | 2fa-entfernen <benutzername> | admin <benutzername> | backup | sicherung-erstellen <datei|->');
    process.exitCode = command ? 1 : 0;
}

db.close();
