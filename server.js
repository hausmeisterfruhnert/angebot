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
// Erlaubt: max. 3 Dateien, je max. 10 MB, nur Fotos (JPG, PNG, WEBP, HEIC) und PDF –
// passend zum Formular („bis zu 3 Fotos oder PDFs, max. 10 MB pro Datei“).
const MAX_DATEIEN = 3;
const ERLAUBTE_DATEITYPEN = {
  'image/jpeg': ['.jpg', '.jpeg'], 'image/png': ['.png'], 'image/webp': ['.webp'],
  'image/heic': ['.heic'], 'image/heif': ['.heif', '.heic'], 'application/pdf': ['.pdf']
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_DATEIEN, fields: 30, fieldSize: 100 * 1024 },
  fileFilter: (req, file, cb) => {
    const endung = (file.originalname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const erlaubt = (ERLAUBTE_DATEITYPEN[file.mimetype] || []).includes(endung);
    if (!erlaubt) {
      req.abgelehnteDateien = (req.abgelehnteDateien || []).concat(file.originalname);
      return cb(null, false); // Datei überspringen, Anfrage trotzdem annehmen
    }
    cb(null, true);
  }
});

// Upload mit verständlicher Fehlermeldung statt Absturz/HTML-Fehlerseite
function dateiUpload(req, res, next) {
  upload.array('dateien', MAX_DATEIEN)(req, res, (err) => {
    if (!err) return next();
    const meldung = (err.code === 'LIMIT_FILE_SIZE') ? 'Eine Datei ist größer als 10 MB.'
      : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') ? 'Bitte höchstens ' + MAX_DATEIEN + ' Dateien anhängen.'
      : 'Die Dateien konnten nicht verarbeitet werden.';
    console.warn('Upload abgelehnt:', err.code || err.message);
    return res.status(400).json({ erfolg: false, fehler: meldung });
  });
}

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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Feste Timeouts: Falls der Mailserver hängt, bricht der Versand ab,
    // statt die ganze Anfrage (und damit Lexoffice) zu blockieren.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
}

/* ------------------------------------------------------------------ *
 * Hilfsfunktionen
 * ------------------------------------------------------------------ */
/* Lexoffice erlaubt nur ca. 2 Anfragen pro Sekunde: alle Aufrufe nacheinander
   mit 600 ms Abstand, bei 429 (Rate limit) automatisch erneut versuchen. */
const LEX_ABSTAND_MS = 600;
let lexWarteschlange = Promise.resolve();
let lexLetzterAufruf = 0;
const warte = (ms) => new Promise(r => setTimeout(r, ms));

function lexofficeRequest(pfad, methode, body) {
  const auftrag = lexWarteschlange.then(() => lexofficeAufruf(pfad, methode, body));
  lexWarteschlange = auftrag.catch(() => {});
  return auftrag;
}

async function lexofficeAufruf(pfad, methode, body) {
  for (let versuch = 1; ; versuch++) {
    const seitLetztem = Date.now() - lexLetzterAufruf;
    if (seitLetztem < LEX_ABSTAND_MS) await warte(LEX_ABSTAND_MS - seitLetztem);
    lexLetzterAufruf = Date.now();
    const antwort = await fetch(LEXOFFICE_BASE_URL + pfad, {
      method: methode,
      headers: {
        'Authorization': 'Bearer ' + LEXOFFICE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (antwort.status === 429 && versuch < 6) { await warte(1000 * versuch); continue; }
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

/* ------------------------------------------------------------------ *
 * Kunde in Lexoffice anlegen – so wie die Kunden dort gepflegt werden:
 *   - mit Firma:  Firmenname + Ansprechpartner (Anrede/Vorname/Nachname, E-Mail, Telefon)
 *   - ohne Firma: Privatperson mit Vorname + Nachname
 *   Adresse = Rechnungsadresse (Straße 1 / PLZ 1 / Ort 1), Telefon = Telefon 1,
 *   Formularangaben als Notiz. Gibt es den Kunden schon (gleiche E-Mail UND
 *   gleicher Name), wird er wiederverwendet und um fehlende Daten ergänzt.
 * ------------------------------------------------------------------ */
const kurz = (v, max = 100) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function teileName(name) {
  let teile = kurz(name, 100).split(/\s+/).filter(Boolean);
  let anrede;
  if (teile.length > 1 && /^(herr|frau)$/i.test(teile[0])) {
    anrede = teile[0][0].toUpperCase() + teile[0].slice(1).toLowerCase();
    teile = teile.slice(1);
  }
  const nachname = teile.length > 1 ? teile.pop() : (teile[0] || '');
  return { anrede, vorname: teile.length ? teile.join(' ') : '', nachname };
}

function telefonFeld(tel) {
  const n = tel.replace(/[^0-9+]/g, '');
  return /^(\+49|0049|0)1[5-7]/.test(n) ? 'mobile' : 'business';
}

async function findeKontakt(email, istFirma, firmenname, nachname) {
  try {
    const r = await lexofficeRequest('/contacts?customer=true&email=' + encodeURIComponent(email), 'GET');
    const liste = r && Array.isArray(r.content) ? r.content : [];
    const gleich = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
    return liste.find(c => istFirma
      ? (c.company && gleich(c.company.name, firmenname))
      : (c.person && gleich(c.person.lastName, nachname))) || null;
  } catch (e) {
    console.warn('Kontaktsuche fehlgeschlagen, lege neuen Kontakt an:', e.status || e.message);
    return null;
  }
}

async function ergaenzeKontakt(id, { telefon, adr, notiz }) {
  const k = await lexofficeRequest('/contacts/' + id, 'GET');
  let geaendert = false;
  k.addresses = k.addresses || {};
  const billing = (k.addresses.billing || [])[0];
  if (adr && !(billing && billing.street && billing.zip && billing.city)) { k.addresses.billing = [adr]; geaendert = true; }
  if (telefon) {
    k.phoneNumbers = k.phoneNumbers || {};
    if (!Object.values(k.phoneNumbers).flat().includes(telefon)) {
      const f = telefonFeld(telefon); k.phoneNumbers[f] = [...(k.phoneNumbers[f] || []), telefon]; geaendert = true;
    }
  }
  if (notiz) { k.note = ((k.note ? k.note + '\n\n' : '') + notiz).slice(0, 1000); geaendert = true; }
  if (!k.addresses.billing && !k.addresses.shipping) delete k.addresses;
  if (geaendert) await lexofficeRequest('/contacts/' + id, 'PUT', k);
  const b = (k.addresses && k.addresses.billing || [])[0];
  return !!(b && b.zip && b.city);
}

async function legeKontaktAn({ name, firma, email, telefon, adresse, notiz }) {
  const istFirma = !!firma;
  const { anrede, vorname, nachname } = teileName(name);
  const tel = kurz(telefon, 30);
  const adr = adresse.vollstaendig
    ? { street: kurz(adresse.strasse), zip: kurz(adresse.plz, 10), city: kurz(adresse.ort, 80), countryCode: 'DE' } : null;

  const vorhanden = await findeKontakt(email, istFirma, kurz(firma), nachname);
  if (vorhanden) {
    let hatAdresse = false;
    try { hatAdresse = await ergaenzeKontakt(vorhanden.id, { telefon: tel, adr, notiz }); }
    catch (e) { console.warn('Kunde konnte nicht ergänzt werden:', e.status || e.message, e.details ? JSON.stringify(e.details) : ''); }
    console.log('Vorhandenen Kunden verwendet und ergänzt:', vorhanden.id);
    return { contactId: vorhanden.id, hatAdresse };
  }

  const payload = { version: 0, roles: { customer: {} }, emailAddresses: { business: [email] } };
  if (istFirma) {
    payload.company = { name: kurz(firma) };
    if (nachname) {
      payload.company.contactPersons = [{
        salutation: anrede, firstName: vorname || undefined, lastName: nachname, primary: true,
        emailAddress: email, phoneNumber: tel || undefined
      }];
    }
  } else {
    payload.person = { salutation: anrede, firstName: vorname || undefined, lastName: nachname || kurz(name) };
  }
  if (tel) payload.phoneNumbers = { [telefonFeld(tel)]: [tel] };
  // Lexoffice verlangt bei per contactId referenzierten Kontakten genau EINE Rechnungsadresse.
  if (adr) payload.addresses = { billing: [adr] };
  if (notiz) payload.note = notiz.slice(0, 1000);

  const ergebnis = await lexofficeRequest('/contacts', 'POST', payload);
  console.log('Neuer Kunde angelegt:', ergebnis.id, istFirma ? '(Firma mit Ansprechpartner)' : '(Privatperson)', tel ? 'mit Telefon' : 'ohne Telefon', adr ? 'mit Adresse' : 'OHNE Adresse');
  return { contactId: ergebnis.id, hatAdresse: !!adr };
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

/* ------------------------------------------------------------------ *
 * Leistungen als Lexoffice-ARTIKEL (Dienstleistung) mit Preis 0 €.
 * Gleiche Artikelnummern wie beim Kalkulator (KALK-...), damit überall
 * dieselben Artikel genutzt werden. Fehlt ein Artikel, wird er angelegt.
 * Optional feste IDs per Umgebungsvariable, z. B. ARTIKEL_WINTER=<ID>.
 * ------------------------------------------------------------------ */
const ARTIKEL = [
  { key: 'hausverwaltung', nr: 'KALK-HAUSVERWALTUNG', titel: 'Hausverwaltung – Betreuung mehrerer Objekte', einheit: 'Monat', test: /hausverwaltung/i },
  { key: 'hausmeister',    nr: 'KALK-HAUSMEISTER',    titel: 'Hausmeisterservice',                          einheit: 'Monat', test: /hausmeister/i },
  { key: 'dachrinne',      nr: 'KALK-DACHRINNE',      titel: 'Dachrinnenreinigung (Dachrinnensauger mit Kamera)', einheit: 'Stück', test: /dachrinne/i },
  { key: 'tiefgarage',     nr: 'KALK-TIEFGARAGE',     titel: 'Tiefgaragenreinigung (Nassreinigung)',        einheit: 'Stück', test: /tiefgarage/i },
  { key: 'winter',         nr: 'KALK-WINTER',         titel: 'Winterdienst',                                einheit: 'Monat', test: /winter/i },
  { key: 'spuelwagen',     nr: 'KALK-SPUELWAGEN',     titel: 'Spülwagenvermietung',                         einheit: 'Stück', test: /sp(ü|ue)lwagen/i },
  { key: 'unterhalt',      nr: 'KALK-UNTERHALT',      titel: 'Unterhaltsreinigung (Büro & Kita)',           einheit: 'Monat', test: /unterhalt/i },
  { key: 'teppich',        nr: 'KALK-TEPPICH',        titel: 'Teppichreinigung (Treppenhaus, Büro, Wohnung)', einheit: 'Stück', test: /teppich/i },
  { key: 'leerstand',      nr: 'KALK-LEERSTAND',      titel: 'Leerstands- und Urlaubsbetreuung',            einheit: 'Monat', test: /leerstand|urlaub/i }
];
const artikelCache = {};
let artikelGeladen = false;

async function ladeArtikelListe() {
  if (artikelGeladen) return;
  for (let seite = 0; seite < 10; seite++) {
    const r = await lexofficeRequest('/articles?type=SERVICE&size=250&page=' + seite, 'GET');
    const liste = (r && Array.isArray(r.content)) ? r.content : [];
    for (const art of liste) {
      const a = ARTIKEL.find(x => x.nr === art.articleNumber);
      if (a) artikelCache[a.key] = art.id;
    }
    if (!r || r.last !== false || liste.length === 0) break;
  }
  artikelGeladen = true;
}

async function artikelFuer(a) {
  const envId = process.env['ARTIKEL_' + a.key.toUpperCase()];
  if (envId) return envId;
  try {
    await ladeArtikelListe();
    if (artikelCache[a.key]) return artikelCache[a.key];
    const neu = await lexofficeRequest('/articles', 'POST', {
      title: a.titel, type: 'SERVICE', articleNumber: a.nr, unitName: a.einheit,
      price: { netPrice: 0, leadingPrice: 'NET', taxRate: 19 }
    });
    if (neu && neu.id) artikelCache[a.key] = neu.id;
    return artikelCache[a.key] || null;
  } catch (e) {
    console.warn('Artikel ' + a.nr + ' nicht verfügbar, nutze Position ohne Artikel:', e.status || e.message, e.details ? JSON.stringify(e.details) : '');
    return null;
  }
}

async function baueLineItems({ leistungen, name, telefon, email, groesse, ort, termin, nachricht, dateien }) {
  const items = [];

  // 1) Jede angefragte Leistung als Artikel mit Preis 0 € (wird nach Besichtigung bepreist)
  for (const leistung of leistungen) {
    const text = String(leistung && (leistung.name || leistung.id || leistung) || '').trim();
    if (!text) continue;
    const a = ARTIKEL.find(x => x.test.test(text));
    const basis = {
      name: (a ? a.titel : text).slice(0, 250), quantity: 1, unitName: a ? a.einheit : 'Stück',
      unitPrice: { currency: 'EUR', netAmount: 0, taxRatePercentage: 19 }
    };
    const id = a ? await artikelFuer(a) : null;
    items.push(id ? Object.assign({ id, type: 'service' }, basis) : Object.assign({ type: 'custom' }, basis));
  }

  // 2) Angaben aus dem Formular weiterhin als Info-Text
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
app.post('/api/anfrage', dateiUpload, async (req, res) => {
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
    leistungen = leistungen.map(l => (l && typeof l === 'object') ? String(l.name || l.id || '') : String(l)).filter(Boolean);

    if (!name || !email) {
      return res.status(400).json({ erfolg: false, fehler: 'Name und E-Mail sind erforderlich.' });
    }

    const files = req.files || [];
    const dateiNamen = files.map(f => f.originalname);
    if (req.abgelehnteDateien) console.warn('Dateien mit unzulässigem Typ übersprungen:', req.abgelehnteDateien.join(', '));
    const adresse = parseAdresse(b.strasse, b.plzOrt);
    const kundenName = firma || name;
    const daten = { leistungen, name, firma, email, telefon, groesse, ort, termin, nachricht, dateien: dateiNamen };

    // E-Mail und Lexoffice laufen UNABHÄNGIG und PARALLEL.
    // Jeder Teil fängt seine Fehler selbst ab – fällt einer aus,
    // läuft der andere trotzdem durch (nichts blockiert das andere).

    async function versendeEmail() {
      if (!mailer) { console.warn('Kein SMTP konfiguriert – E-Mail übersprungen.'); return false; }
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
        return true;
      } catch (e) {
        console.error('E-Mail-Fehler:', e.message);
        return false;
      }
    }

    async function legeInLexofficeAn() {
      if (!LEXOFFICE_API_KEY) { console.warn('Kein LEXOFFICE_API_KEY – Lexoffice übersprungen.'); return { ok: false, id: null }; }
      try {
        const notiz = ['Anfrage über Website-Formular vom ' + new Date().toLocaleDateString('de-DE'),
          leistungen.length ? 'Leistungen: ' + leistungen.join(', ') : '',
          groesse ? 'Größen / Umfang: ' + groesse : '', ort ? 'Ort: ' + ort : '',
          termin ? 'Wunschtermin: ' + termin : '', nachricht ? 'Nachricht: ' + nachricht : ''].filter(Boolean).join('\n');
        const { contactId, hatAdresse } = await legeKontaktAn({ name, firma, email, telefon, adresse, notiz });
        const lineItems = await baueLineItems(daten);
        const angebot = await legeAngebotAn({ contactId, kundenName, hatAdresse, lineItems });
        return { ok: true, id: angebot.id };
      } catch (e) {
        console.error('Lexoffice-Fehler:', e.status || '', e.details || e.message);
        return { ok: false, id: null };
      }
    }

    // Promise.all wirft hier nie, weil beide Funktionen ihre Fehler selbst abfangen.
    const [emailOk, lex] = await Promise.all([versendeEmail(), legeInLexofficeAn()]);
    const lexOk = lex.ok;
    const angebotId = lex.id;

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
