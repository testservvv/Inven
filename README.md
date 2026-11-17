# Inventar

Web-Anwendung zur Verwaltung versicherter Hardware: Geräte erfassen, Defekte und
Prüfungen (Kalibrierung, DGUV V3, Wartung) im Blick behalten und beides per
QR-Code direkt am Gerät eintragen.

- **Inventar** mit Suche, Filtern und Sortierung: Bezeichnung, Inventarnummer, Kategorie, Hersteller, Modell,
  Seriennummer, Standort, Raum, Verantwortlicher, Status, Kaufdatum, Preis, Lieferant, Rechnungsnummer,
  Garantie, Eigentumsverhältnis, Versicherung, Versicherungswert, Notizen
- **Versicherungen**: Policen mit Versicherungssumme – die Übersicht zeigt, ob der erfasste Gerätewert noch gedeckt ist
- **Defekte** melden (Schweregrad, Fotos), bearbeiten und als behoben markieren
- **Prüfungen**: Prüfpläne je Gerät mit Intervall, Fälligkeiten, Prüfprotokoll und Nachweisen (PDF/Foto)
- **QR-Etiketten** als PDF für A4-Etikettenbögen und Etikettendrucker; Scan öffnet die Schnellaktionen des Geräts
- **Fotos & Belege** je Gerät, **CSV-Import und -Export**
- **Komplettsicherung & Umzug**: alle Daten als eine Datei herunterladen und auf einem neuen Server einspielen
- **Sicherer Login**: Rollen (Administrator/Mitarbeiter), optionale Zwei-Faktor-Anmeldung, Sperre bei Fehlversuchen
- Helles und dunkles Design, für Handy und Desktop

Technik: Node.js, SQLite (eine Datei), serverseitig gerendertes HTML ohne Build-Schritt. Fünf Laufzeit-Abhängigkeiten.

---

## Installation auf einem Server (Docker)

Voraussetzungen: ein Linux-Server mit [Docker](https://docs.docker.com/engine/install/) und eine (Sub-)Domain,
deren DNS-Eintrag auf den Server zeigt, z. B. `inventar.meine-firma.de`. Ports 80 und 443 müssen erreichbar sein.

```bash
cp .env.example .env
```

In `.env` die eigene Domain eintragen, dann starten:

```bash
docker compose up -d --build
```

Der mitgelieferte Reverse-Proxy (Caddy) holt automatisch ein TLS-Zertifikat; die Anwendung ist danach
ausschließlich per HTTPS erreichbar.

### Ersteinrichtung

Beim ersten Start gibt es noch kein Konto. Der Link zur Einrichtung steht im Protokoll:

```bash
docker compose logs app
```

Den dort angezeigten Link (`https://…/setup?token=…`) öffnen und das erste Administrator-Konto anlegen.
Ohne diesen Code kann niemand Fremdes die frische Installation übernehmen. Alternativ lässt sich ein fester
Code über die Umgebungsvariable `SETUP_TOKEN` vorgeben.

### Aktualisieren

```bash
docker compose up -d --build
```

Datenbank-Änderungen werden beim Start automatisch eingespielt.

### Betrieb hinter einem eigenen Reverse-Proxy

Wer bereits nginx, Traefik o. Ä. betreibt, startet nur den Dienst `app` und leitet auf Port 3000 weiter.
Wichtig: `APP_URL` auf die öffentliche https-Adresse setzen, `TRUST_PROXY=1` setzen und den `Host`-Header
durchreichen (nginx: `proxy_set_header Host $host;`). Außerdem die Upload-Grenze anheben: für Fotos und Belege
reichen 50 MB, zum Einspielen einer Komplettsicherung beim Umzug muss sie größer sein als die Sicherungsdatei
(nginx: `client_max_body_size 4g;`, dazu `proxy_request_buffering off;`).

### Einstellungen (Umgebungsvariablen)

| Variable        | Standard        | Bedeutung                                                                             |
| --------------- | --------------- | ------------------------------------------------------------------------------------- |
| `APP_URL`       | –               | Öffentliche Adresse, z. B. `https://inventar.meine-firma.de`. Steckt in den QR-Codes. |
| `TRUST_PROXY`   | `0`             | Anzahl vertrauenswürdiger Reverse-Proxys vor der Anwendung (mit Caddy: `1`).           |
| `PORT`          | `3000`          | Port der Anwendung.                                                                   |
| `DATA_DIR`      | `./data`        | Ablage für Datenbank, Uploads, Sicherungen und Schlüssel (im Container: `/data`).      |
| `MAX_UPLOAD_MB` | `15`            | Maximale Größe einer hochgeladenen Datei.                                             |
| `MAX_RESTORE_MB`| `4096`          | Maximale Größe einer Komplettsicherung, die beim Umzug eingespielt werden kann.         |
| `BACKUP_KEEP`   | `14`            | Anzahl aufbewahrter täglicher Datenbank-Sicherungen (`0` = aus).                       |
| `SETUP_TOKEN`   | zufällig        | Fester Code für die Ersteinrichtung.                                                  |
| `TZ`            | `Europe/Berlin` | Zeitzone für Fälligkeiten und Datumsanzeigen.                                         |

---

## Datensicherung & Umzug

Alle Daten liegen im Volume `inventar-data` (im Container `/data`):

| Inhalt             | Bedeutung                                                                  |
| ------------------ | -------------------------------------------------------------------------- |
| `inventar.sqlite`  | Datenbank                                                                  |
| `uploads/`         | Fotos und Belege                                                           |
| `backups/`         | automatische tägliche Kopien der Datenbank                                 |
| `app.key`          | Schlüssel, mit dem die 2FA-Geheimnisse in der Datenbank verschlüsselt sind |

### Komplettsicherung

Unter **Einstellungen → Datensicherung & Umzug** lädt ein Administrator nach Eingabe seines Passworts eine
einzelne Datei `inventar-sicherung-JJJJ-MM-TT.tar.gz` herunter. Sie enthält alles: Datenbank, sämtliche
Fotos und Belege sowie `app.key`. Es ist ein gewöhnliches tar-Archiv, das sich mit jedem Packprogramm öffnen lässt.

Die Datei enthält auch die Anmeldedaten aller Nutzer (Passwörter nur als nicht umkehrbarer Hash) und sollte
entsprechend sicher aufbewahrt werden.

Für eine regelmäßige Sicherung auf einem anderen System, z. B. per Cronjob, schreibt dieser Befehl die
Komplettsicherung direkt in eine Datei auf dem Server:

```bash
docker compose exec -T app node src/cli.js sicherung-erstellen - > inventar-sicherung-$(date +%F).tar.gz
```

### Umzug auf einen anderen Server

1. **Alter Server:** Unter *Einstellungen → Datensicherung & Umzug* die Komplettsicherung herunterladen.
2. **Neuer Server:** Die Anwendung wie oben beschrieben installieren und den Einrichtungslink aus
   `docker compose logs app` öffnen.
3. Statt ein Konto anzulegen, **„Umzug: Komplettsicherung einspielen“** aufklappen, den Einrichtungscode
   eintragen, die Datei auswählen und einspielen.
4. Mit dem bisherigen Konto anmelden: Passwörter und Zwei-Faktor-Anmeldung gelten weiter.

Gut zu wissen:

- Eine Sicherung lässt sich **nur in eine frische Installation** (noch ohne Konto) einspielen. Bestehende Daten
  können so nicht versehentlich überschrieben werden. Ist die Datei beschädigt oder unvollständig, wird nichts
  verändert.
- Nach dem Umzug melden sich alle Nutzer einmal neu an.
- **Gleiche Domain:** Nur den DNS-Eintrag auf den neuen Server umstellen; alle gedruckten QR-Etiketten bleiben gültig.
  **Neue Domain:** Die QR-Codes enthalten die alte Adresse – Etiketten neu drucken.
- Eine Sicherung aus einer älteren Programmversion kann in eine neuere eingespielt werden (die Datenbank wird
  automatisch angepasst), umgekehrt nicht.
- Größtmögliche Datei: `MAX_RESTORE_MB` (Standard 4096 MB). Läuft ein eigener Reverse-Proxy vor der Anwendung,
  muss auch dessen Upload-Grenze groß genug sein (nginx: `client_max_body_size`). Der mitgelieferte Caddy hat keine Grenze.

Auch nach einem Totalausfall des Servers ist das der Weg zurück: neu installieren, Sicherung einspielen.

### Automatische Tagessicherungen

Zusätzlich legt die Anwendung täglich eine Kopie der Datenbank in `backups/` ab. Diese Kopien schützen vor
versehentlichem Löschen, **nicht** vor einem Ausfall des Servers (dafür die Komplettsicherung).
Einen Tagesstand zurückholen (`JJJJ-MM-TT` durch das gewünschte Datum ersetzen):

```bash
docker compose stop app
```

```bash
docker compose run --rm --no-deps app sh -c 'cp /data/backups/inventar-JJJJ-MM-TT.sqlite /data/inventar.sqlite && rm -f /data/inventar.sqlite-wal /data/inventar.sqlite-shm'
```

```bash
docker compose start app
```

Fotos und Belege sind in den Tagessicherungen nicht enthalten; sie werden ohnehin nur gelöscht, wenn jemand sie
ausdrücklich löscht.

---

## Rollen

| Aktion                                                    | Mitarbeiter | Administrator |
| --------------------------------------------------------- | :---------: | :-----------: |
| Geräte ansehen und suchen, QR-Codes scannen               |      ✓      |       ✓       |
| Defekte melden, Status ändern, Fotos anhängen             |      ✓      |       ✓       |
| Prüfungen eintragen (inkl. Nachweis)                      |      ✓      |       ✓       |
| Preise, Versicherungsdaten und Rechnungen sehen           |      –      |       ✓       |
| Geräte anlegen, ändern, löschen; Dateien verwalten        |      –      |       ✓       |
| Prüfpläne, Stammdaten, Etiketten, Import/Export           |      –      |       ✓       |
| Nutzer verwalten, Einträge löschen, Einstellungen         |      –      |       ✓       |

Neue Nutzer erhalten ein vorläufiges Passwort, das beim ersten Anmelden geändert werden muss. E-Mails versendet
die Anwendung nicht; ein vergessenes Passwort setzt ein Administrator unter „Nutzer“ zurück.

### Notfall: kein Administrator kommt mehr hinein

```bash
docker compose exec app node src/cli.js nutzer
```

```bash
docker compose exec app node src/cli.js passwort BENUTZERNAME
```

```bash
docker compose exec app node src/cli.js 2fa-entfernen BENUTZERNAME
```

---

## QR-Etiketten

Jedes Gerät erhält beim Anlegen einen eigenen, unveränderlichen QR-Code. Er enthält nur einen Link
(`https://…/q/CODE`) – keine Gerätedaten. Wer ihn scannt, muss angemeldet sein und landet dann auf der
Schnellansicht des Geräts: *Defekt melden*, *Prüfung eintragen*, offene Defekte.

- Scannen geht mit der Kamera-App des Handys oder mit dem eingebauten Scanner (Menüpunkt „Scannen“).
- Etiketten: im Inventar Geräte ankreuzen → „Etiketten drucken“, oder unter „QR-Etiketten“ alle auf einmal.
- Beim Drucken des PDFs **„Tatsächliche Größe“ (100 %)** wählen. Für neue Bögen zuerst einen Probedruck mit
  eingeschaltetem Rahmen auf Normalpapier machen und gegen den Bogen halten; Abweichungen lassen sich über
  „Feinjustierung“ ausgleichen.
- Die QR-Codes enthalten die Adresse aus `APP_URL`. Ändert sich die Domain, müssen Etiketten neu gedruckt werden.

## CSV-Import

Unter „Import & Export“ lässt sich eine Vorlage herunterladen. Eigene Excel-Listen als
„CSV UTF-8 (durch Trennzeichen getrennt)“ speichern und hochladen; die Spalten werden anschließend zugeordnet
und geprüft, bevor etwas gespeichert wird. Kategorien, Standorte und Versicherungen, die es noch nicht gibt,
werden angelegt. Spalten „Fällig: …“ setzen die nächste Fälligkeit der jeweiligen Prüfart. Eine exportierte
Inventarliste kann bearbeitet und mit der Option „Vorhandene Geräte aktualisieren“ wieder eingelesen werden.

---

## Sicherheit im Überblick

- Passwörter: scrypt (N=2¹⁵, r=8, p=3) mit eigenem Salt je Konto; Mindestlänge 10 Zeichen, gängige Passwörter werden abgelehnt
- Sitzungen: zufälliges Token im Cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-`-Präfix); in der Datenbank
  liegt nur dessen Hash. Abmelden, Passwortwechsel und Deaktivieren beenden Sitzungen sofort
- Anmeldeschutz: steigende Wartezeiten nach Fehlversuchen (je Konto und Adresse), identische Antworten für
  unbekannte und bekannte Benutzernamen
- Zwei-Faktor-Anmeldung (TOTP) mit Wiederherstellungscodes; Geheimnisse verschlüsselt gespeichert (AES-256-GCM)
- Schutz vor Cross-Site-Angriffen: CSRF-Token in jedem Formular, Prüfung der Herkunft, strikte
  Content-Security-Policy ohne Inline-Skripte, HSTS
- Uploads: Typ wird am Dateiinhalt erkannt (nur JPEG, PNG, WebP, GIF, PDF), Ablage außerhalb des Web-Verzeichnisses,
  Auslieferung nur an angemeldete Nutzer
- Alle Datenbankzugriffe über vorbereitete Anweisungen; alle Ausgaben werden automatisch maskiert
- Protokoll aller Änderungen unter „Aktivität“
- Der Container läuft ohne Root-Rechte

Empfehlung: Für Administratoren die Zwei-Faktor-Anmeldung aktivieren („Mein Konto“) und Server sowie
Docker-Images regelmäßig aktualisieren.

---

## Entwicklung

```bash
npm install
```

```bash
npm run dev
```

Die Anwendung läuft dann auf <http://localhost:3000>; der Einrichtungslink steht in der Konsole.
Daten liegen in `./data`.

```bash
npm test
```

Aufbau:

```
src/
  server.js        Start des HTTP-Servers
  cli.js           Wartungsbefehle (Passwort zurücksetzen, Sicherung …)
  config.js        Umgebungsvariablen
  db.js            SQLite-Zugriff und Schema-Migrationen
  lib/             Hilfsfunktionen ohne Datenbank (Passwörter, TOTP, CSV, QR, Etiketten-PDF …)
  services/        Geschäftslogik und Datenbankabfragen
  web/             Routen, Seitenlayout und HTML-Bausteine
public/            Stylesheet, Skripte, Icons
test/              Automatisierte Tests
```

Verwendete Bibliotheken: [Hono](https://hono.dev) (HTTP), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3),
[pdf-lib](https://pdf-lib.js.org) (Etiketten), [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator),
[jsQR](https://github.com/cozmo/jsQR) (Scanner-Fallback im Browser), Icons von [Lucide](https://lucide.dev).
