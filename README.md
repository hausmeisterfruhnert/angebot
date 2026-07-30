# Angebotsformular-Server – Hausmeisterservice Fruhnert

Eigenständiger Server (Node.js/Express) **nur für das Formular „Angebot anfordern"**.
Er ist unabhängig vom Objekt-Kalkulator – ein eigenes GitHub-Repo, ein eigener
Render-Dienst. Der Kalkulator wird dadurch nicht angefasst.

Der Server nimmt die Formulardaten entgegen und
1. **verschickt sie zuverlässig per E-Mail** (SMTP) an euer Postfach – serverseitig,
   es öffnet sich beim Besucher **kein** E-Mail-Programm;
2. **legt zusätzlich Kontakt + Angebots-Entwurf in Lexoffice an** (best effort).

Fällt Lexoffice mal aus, kommt die Anfrage trotzdem als E-Mail an.

## Einrichtung (Schritt für Schritt)

1. **Neues GitHub-Repo** anlegen und diese Dateien hochladen:
   `server.js`, `package.json`, `.env.example`, `.gitignore`
   (NICHT hochladen: `node_modules`, `.env`).

2. Bei [Render](https://render.com) einen **neuen Web Service** aus dem Repo erstellen:
   - Build Command: `npm install`
   - Start Command: `npm start`

3. **Umgebungsvariablen** beim neuen Dienst eintragen (Werte siehe `.env.example`):
   - `LEXOFFICE_API_KEY` → **derselbe Key-Wert wie beim Kalkulator** (einfach nochmal einfügen)
   - `SMTP_HOST=mail.agenturserver.de`, `SMTP_PORT=465`, `SMTP_SECURE=true`,
     `SMTP_USER`, `SMTP_PASS`, `ABSENDER_EMAIL`, `EMPFAENGER_EMAIL`
   - `ERLAUBTE_DOMAINS` (die Domain, auf der das Formular liegt)

4. Nach dem Deploy die **Adresse des neuen Dienstes** kopieren
   (z. B. `https://fruhnert-angebot.onrender.com`).

5. Im Formular (`angebot-anfordern.html`) oben im `<script>` die Zeile
   `const SERVER_URL = '...';` auf **diese neue Adresse** setzen.

## Funktioniert es? – Schnelltest

- Startseite des Dienstes aufrufen → muss **„Angebotsformular-Server läuft."** anzeigen.
- Formular absenden → in der Browser-Konsole erscheint `{erfolg:true, emailOk:true, lexOk:true, ...}`.
- E-Mail-Eingang prüfen und in Lexoffice unter **Angebote** den neuen **Entwurf** prüfen.

## Endpunkt

`POST /api/anfrage` (multipart/form-data) – Felder: `name`, `firma`, `email`,
`telefon`, `strasse`, `plzOrt`, `groesse`, `ort`, `termin`, `nachricht`,
`leistungenJson` (JSON-Array), `dateien` (0–10 Dateien).

## Gut zu wissen

- Lexoffice-Basis-URL ist `https://api.lexware.io/v1`.
- Angebote werden als **Entwurf** ohne Preise angelegt (das Formular fragt keine
  Preise ab) – die Angaben stehen als Text-Positionen drin, ihr bepreist sie dann.
- Fotos aus dem Formular hängen an der **E-Mail** (nicht an Lexoffice).
- Render Free-Tier „schläft" nach Inaktivität – der erste Aufruf kann 30–60 Sek.
  dauern, bis der Dienst wach ist.
