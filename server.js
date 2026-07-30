/**
 * Angebotsformular-Server für Hausmeisterservice Fruhnert
 * ------------------------------------------------------
 * Nimmt die Formulardaten entgegen und
 *   1) verschickt sie ZUVERLÄSSIG per E-Mail (SMTP) an euch  → primäre Absicherung
 *   2) legt zusätzlich Kontakt + Angebot in Lexoffice/Lexware Office an  → best effort
 *
 * Auch wenn Lexoffice mal nicht erreichbar ist, kommt die Anfrage per E-Mail an.
 * Der API-Key und alle Zugangsdaten liegen NUR in Umgebungsvariablen, nie im Code.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();

// Render & die meisten Hoster laufen hinter einem Proxy – sonst wirft
// express-rate-limit einen X-Forwarded-For-Fehler.
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));

/* ------------------------------------------------------------------ *
 * CORS – nur die eigene(n) Website-Domain(s) erlauben
 * ------------------------------------------------------------------ */
const ERLAUBTE_DOMAINS = (process.env.ERLAUBTE_DOMAINS || '')
  .split(',').map(d => d.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (ERLAUBTE_DOMAINS.length === 0) return callback(null, true); // Testphase
    if (!origin) return callback(null, true);
    if (ERLAUBTE_DOMAINS.includes(origin)) return callback(null, true);
    return callback(new Error('Diese Domain ist nicht freigeschaltet.'));
  }
}));

// Rate-Limiting gegen Spam / Missbrauch
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));

// Datei-Uploads (Fotos & Co.) im Arbeitsspeicher entgegennehmen
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 } // 10 MB / max 10 Dateien
});

/* ------------------------------------------------------------------ *
 * Konfiguration
 * ------------------------------------------------------------------ */
const LEXOFFICE_API_KEY = process.env.LEXOFFICE_API_KEY;
const LEXOFFICE_BASE_URL = 'https://api.lexware.io/v1'; // NICHT api.lexoffice.io (veraltet)

const EMPFAENGER_EMAIL = process.env.EMPFAENGER_EMAIL || 'info@hausmeister-fruhnert.de';
const ABSENDER_EMAIL   = process.env.ABSENDER_EMAIL   || process.env.SMTP_USER;

let mailer = null;
if (process.env.SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true', // true bei Port 465
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

/* ------------------------------------------------------------------ *
 * Hilfsfunktionen
 * ------------------------------------------------------------------ */
async function lexofficeRequest(pfad, methode, body) {
  const antwort = await fetch(LEXOFFICE_BASE_URL + pfad, {
    method: methode,
    headers: {
      'Authorization': 'Bearer ' + LEXOFFICE_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await antwort.text();
  let daten = null;
  try { daten = text ? JSON.parse(text) : null; } catch (e) { daten = { rohtext: text }; }
  if (!antwort.ok) {
    const fehler = new Error('Lexoffice-API-Fehler: ' + antwort.status);
    fehler.status = antwort.status;
    fehler.details = daten;
    throw fehler;
  }
  return daten;
}

// "82194 Gröbenzell" / "Musterstr. 1" → strukturierte Adresse
function parseAdresse(strasse, plzOrt) {
  strasse = (strasse || '').trim();
  const raw = (plzOrt || '').trim();
  const m = raw.match(/(\d{4,5})\s*(.*)/);
  const plz = m ? m[1] : '';
  const ort = m ? (m[2] || '').trim() : raw;
  return { strasse, plz, ort, vollstaendig: Boolean(strasse && plz && ort) };
}

async function legeKontaktAn({ kundenName, email, telefon, adresse }) {
  const payload = {
    version: 0,
    roles: { customer: {} },
    company: { name: kundenName },
    emailAddresses: { business: [email] }
  };
  // Hinweis: Kontakt-Payload bewusst identisch zum funktionierenden Kalkulator
  // gehalten. Telefon steht in der E-Mail und im Angebotstext.

  // 🔴 Lexoffice verlangt bei per contactId referenzierten Kontakten GENAU EINE
  //    Rechnungsadresse. Nur setzen, wenn vollständig – sonst Fallback im Angebot.
  if (adresse.vollstaendig) {
    payload.addresses = {
      billing: [{
        street: adresse.strasse,
        zip: adresse.plz,
        city: adresse.ort,
        countryCode: 'DE'
      }]
    };
  }

  const ergebnis = await lexofficeRequest('/contacts', 'POST', payload);
  return { contactId: ergebnis.id, hatAdresse: adresse.vollstaendig };
}

async function legeAngebotAn({ contactId, kundenName, hatAdresse, lineItems }) {
  const heute = new Date();
  const ablauf = new Date(heute);
  ablauf.setDate(ablauf.getDate() + 30); // 30 Tage gültig (expirationDate ist PFLICHT)

  // Fallback: Kontakt ohne Adresse NICHT per contactId referenzieren,
  // sondern One-time-Adresse (name + countryCode sind beide Pflicht).
  const address = hatAdresse
    ? { contactId }
    : { name: kundenName, countryCode: 'DE' };

  const payload = {
    voucherDate: heute.toISOString(),
    expirationDate: ablauf.toISOString(),
    address,
    lineItems,                          // darf nicht leer sein
    totalPrice: { currency: 'EUR' },
    taxConditions: { taxType: 'net' },
    introduction: 'Vielen Dank für Ihre Anfrage über unser Online-Formular.',
    remark: 'Unverbindliche Angebotsanfrage – Positionen bitte noch bepreisen.'
  };

  return await lexofficeRequest('/quotations', 'POST', payload);
}

function baueLineItems({ leistungen, name, telefon, email, groesse, ort, termin, nachricht, dateien }) {
  const items = [];

  if (leistungen.length) {
    items.push({ type: 'text', name: 'Angefragte Leistungen', description: leistungen.join(', ') });
  }

  const zeilen = [];
  zeilen.push('Ansprechpartner: ' + name);
  if (telefon)  zeilen.push('Telefon: ' + telefon);
  if (email)    zeilen.push('E-Mail: ' + email);
  if (groesse)  zeilen.push('Größen / Umfang: ' + groesse);
  if (ort)      zeilen.push('Ort: ' + ort);
  if (termin)   zeilen.push('Wunschtermin: ' + termin);
  if (nachricht) zeilen.push('Nachricht: ' + nachricht);
  if (dateien && dateien.length) zeilen.push('Angehängte Dateien: ' + dateien.join(', '));
  items.push({ type: 'text', name: 'Angaben aus dem Formular', description: zeilen.join('\n') });

  // Sicherheitsnetz: lineItems dürfen nie komplett leer sein
  if (items.length === 0) {
    items.push({ type: 'text', name: 'Anfrage', description: 'Angebotsanfrage über das Website-Formular.' });
  }
  return items;
}

function baueEmail(daten, adresse) {
  const { leistungen, name, firma, email, telefon, groesse, ort, termin, nachricht, dateien } = daten;
  const zeile = (label, wert) => wert
    ? `<tr><td style="padding:6px 14px;color:#6a8598;font-weight:600;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:6px 14px;color:#12303f">${String(wert).replace(/\n/g, '<br>')}</td></tr>`
    : '';
  const adrText = [adresse.strasse, [adresse.plz, adresse.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto;border:1px solid #e3ecf2;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0969A9,#058586);color:#fff;padding:20px 24px">
      <h2 style="margin:0;font-size:20px">Neue Angebotsanfrage</h2>
      <p style="margin:4px 0 0;opacity:.9;font-size:13px">Eingegangen über das Website-Formular</p>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${zeile('Leistungen', leistungen.join(', '))}
      ${zeile('Name', name)}
      ${zeile('Firma', firma)}
      ${zeile('E-Mail', email)}
      ${zeile('Telefon', telefon)}
      ${zeile('Adresse', adrText)}
      ${zeile('Größen / Umfang', groesse)}
      ${zeile('Ort', ort)}
      ${zeile('Wunschtermin', termin)}
      ${zeile('Nachricht', nachricht)}
      ${zeile('Dateien', (dateien || []).join(', '))}
    </table>
    <div style="padding:14px 24px;color:#6a8598;font-size:12px;border-top:1px solid #e3ecf2">
      Automatisch versendet vom Angebotsformular · Antworten Sie direkt auf diese Mail, um dem Kunden zu schreiben.
    </div>
  </div>`;

  const text =
    `Neue Angebotsanfrage\n\n` +
    `Leistungen: ${leistungen.join(', ')}\n` +
    `Name: ${name}\n` +
    (firma ? `Firma: ${firma}\n` : '') +
    `E-Mail: ${email}\n` +
    `Telefon: ${telefon}\n` +
    (adrText ? `Adresse: ${adrText}\n` : '') +
    (groesse ? `Größen/Umfang: ${groesse}\n` : '') +
    (ort ? `Ort: ${ort}\n` : '') +
    (termin ? `Wunschtermin: ${termin}\n` : '') +
    (nachricht ? `Nachricht: ${nachricht}\n` : '');

  return { html, text };
}

/* ------------------------------------------------------------------ *
 * Haupt-Endpunkt: Anfrage entgegennehmen
 * ------------------------------------------------------------------ */
app.post('/api/anfrage', upload.array('dateien', 10), async (req, res) => {
  try {
    const b = req.body || {};
    const name    = (b.name || '').trim();
    const firma   = (b.firma || '').trim();
    const email   = (b.email || '').trim();
    const telefon = (b.telefon || '').trim();
    const groesse = (b.groesse || '').trim();
    const ort     = (b.ort || '').trim();
    const termin  = (b.termin || '').trim();
    const nachricht = (b.nachricht || '').trim();

    let leistungen = [];
    try { leistungen = JSON.parse(b.leistungenJson || '[]'); } catch (e) { leistungen = []; }
    if (!Array.isArray(leistungen)) leistungen = [];

    if (!name || !email) {
      return res.status(400).json({ erfolg: false, fehler: 'Name und E-Mail sind erforderlich.' });
    }

    const files = req.files || [];
    const dateiNamen = files.map(f => f.originalname);
    const adresse = parseAdresse(b.strasse, b.plzOrt);
    const kundenName = firma || name;
    const daten = { leistungen, name, firma, email, telefon, groesse, ort, termin, nachricht, dateien: dateiNamen };

    let emailOk = false;
    let lexOk = false;
    let angebotId = null;

    // 1) E-Mail-Benachrichtigung (primär, zuverlässig)
    if (mailer) {
      try {
        const { html, text } = baueEmail(daten, adresse);
        await mailer.sendMail({
          from: `"Angebotsformular" <${ABSENDER_EMAIL}>`,
          to: EMPFAENGER_EMAIL,
          replyTo: email ? `"${name}" <${email}>` : undefined,
          subject: `Neue Angebotsanfrage – ${name}${leistungen.length ? ' (' + leistungen.join(', ') + ')' : ''}`,
          html, text,
          attachments: files.map(f => ({ filename: f.originalname, content: f.buffer }))
        });
        emailOk = true;
      } catch (e) {
        console.error('E-Mail-Fehler:', e.message);
      }
    } else {
      console.warn('Kein SMTP konfiguriert – E-Mail übersprungen.');
    }

    // 2) Lexoffice (zusätzlich, best effort)
    if (LEXOFFICE_API_KEY) {
      try {
        const { contactId, hatAdresse } = await legeKontaktAn({ kundenName, email, telefon, adresse });
        const lineItems = baueLineItems(daten);
        const angebot = await legeAngebotAn({ contactId, kundenName, hatAdresse, lineItems });
        angebotId = angebot.id;
        lexOk = true;
      } catch (e) {
        console.error('Lexoffice-Fehler:', e.status || '', e.details || e.message);
      }
    } else {
      console.warn('Kein LEXOFFICE_API_KEY konfiguriert – Lexoffice übersprungen.');
    }

    if (!emailOk && !lexOk) {
      return res.status(502).json({ erfolg: false, fehler: 'Anfrage konnte weder per E-Mail noch in Lexoffice verarbeitet werden.' });
    }
    return res.json({ erfolg: true, emailOk, lexOk, angebotId });

  } catch (err) {
    console.error('Unerwarteter Fehler:', err.message);
    return res.status(500).json({ erfolg: false, fehler: 'Interner Serverfehler.' });
  }
});

// Health-Check (für Render / Uptime)
app.get('/', (req, res) => res.send('Angebotsformular-Server läuft.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server läuft auf Port ' + PORT));
