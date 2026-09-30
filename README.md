# node-red-contrib-viessmann

Node-RED-Nodes für die **Viessmann IoT API** (ViCare / Vitoconnect): vollautomatische Anmeldung,
automatische Erkennung der verfügbaren Datenpunkte, Lesen und abgesichertes Schreiben.

[![CI](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml/badge.svg)](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/node-red-contrib-viessmann.svg)](https://www.npmjs.com/package/node-red-contrib-viessmann)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Dank an Rustimation.eu

Dieses Paket gäbe es nicht ohne die ausführliche und geduldig gepflegte Anleitung
**„Viessmann API und Node-Red – Teil 2 – API Zugriff“** auf
[rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).

Dort ist der komplette Weg vom Viessmann-Developer-Konto über Client-ID, Code Challenge und
Authorization Code bis zum Refresh Token Schritt für Schritt beschrieben – inklusive der
Stolpersteine bei Docker, Home Assistant, ioBroker und Homematic. Diese Vorarbeit hat den Zugang
zur API überhaupt erst nachvollziehbar gemacht. **Herzlichen Dank dafür.**

Was hier hinzukommt: Der dort aus mehreren Nodes zusammengesteckte Ablauf läuft jetzt vollständig
in einer einzigen Konfigurations-Node – ohne `http in`-Node, ohne manuelles Auslösen und mit der
richtigen Reihenfolge beim allerersten Start.

---

## Was das Paket kann

| Node | Aufgabe |
|---|---|
| **Viessmann API** (Konfiguration) | Vollautomatische Anmeldung und Token-Erneuerung, gemeinsamer Datencache, Freigabe für Schreibzugriffe |
| **Viessmann lesen** | Datenpunkte abfragen, filtern, in vier Formaten ausgeben, Status und Fehler getrennt |
| **Viessmann schreiben** | Befehle ausführen, mit Validierung gegen die echten Wertebereiche der API |

**Kernidee:** Es gibt keine fest eingebaute Datenpunktliste. Alles wird aus der Antwort der API
abgeleitet – auch die Schreibbefehle samt Minimum, Maximum, Schrittweite und Auswahllisten. Damit
funktioniert das Paket mit jedem Viessmann-Gerät und zeigt jedem Nutzer nur das, was **seine**
Anlage tatsächlich kann.

---

## Installation

### Über die Node-RED-Palette (nach Veröffentlichung auf npm)

Menü → *Palette verwalten* → *Installieren* → `node-red-contrib-viessmann`

### Node-RED im Docker-Container (Raspberry Pi)

```bash
unzip node-red-contrib-viessmann-0.3.0.zip
cd node-red-contrib-viessmann
./tools/install-docker.sh node-red
```

Oder von Hand:

```bash
docker cp node-red-contrib-viessmann node-red:/data/node-red-contrib-viessmann
docker exec -it node-red npm install --prefix /data /data/node-red-contrib-viessmann
docker restart node-red
```

Danach den Editor im Browser mit **Strg+F5** neu laden.

---

## Einrichten

### 1. Einmalig im Viessmann Developer Portal

1. Die Anlage muss in der **ViCare-App** registriert sein und dort funktionieren.
2. Mit denselben Zugangsdaten bei
   [app.developer.viessmann-climatesolutions.com](https://app.developer.viessmann-climatesolutions.com) anmelden.
3. Unter *Your Clients* einen Client anlegen:
   - **Google reCAPTCHA ausschalten** – das ist Pflicht, sonst ist keine automatische Anmeldung möglich.
   - **Redirect URI** eintragen, z. B. `http://localhost:1880/authcode`.
4. Speichern – die **Client-ID** wird angezeigt.

Wer den Zugang schon nach der Rustimation-Anleitung eingerichtet hat, übernimmt einfach die
vorhandene Client-ID und Redirect-URI.

### 2. In Node-RED

Eine *Viessmann lesen*-Node auf die Arbeitsfläche ziehen, bei *Verbindung* eine neue Konfiguration
anlegen und eintragen:

| Feld | Inhalt |
|---|---|
| **Client-ID** | aus dem Developer Portal |
| **Redirect-URI** | exakt wie im Portal hinterlegt |
| **Code Challenge** | optional – vorhandene übernehmen, mit *erzeugen* neu anlegen oder leer lassen |
| **Benutzername** | E-Mail-Adresse des ViCare-Kontos |
| **Passwort** | Passwort des ViCare-Kontos |

**Verbindung testen** klicken – der Test funktioniert schon vor dem ersten Deploy und meldet
Installation, Gateway und Anzahl der Datenpunkte. Dann **Fertig** und **Deploy**. Mehr ist nicht zu tun.

### Was dabei automatisch passiert

```
Refresh Token vorhanden?
 ├─ ja   → Access Token damit holen
 │          └─ von Viessmann abgelehnt? → weiter wie „nein“
 └─ nein → mit Benutzer + Passwort anmelden (GET /authorize, Basic Auth)
            → Authorization Code aus der Weiterleitung lesen
            → Code + Code Challenge gegen Access- und Refresh-Token tauschen
            → Refresh Token verschlüsselt speichern
```

Das Access Token wird kurz vor Ablauf erneuert, nach einem HTTP 401 sofort.

Zwei Unterschiede zum ursprünglichen Flow:

- **Reihenfolge beim Erststart:** Beim allerersten Start gibt es noch kein Refresh Token. Die Node
  versucht dann gar nicht erst eine Erneuerung mit leerem Token, sondern meldet sich direkt an.
- **Kein `http in`-Node nötig:** Die Node folgt der Weiterleitung von Viessmann nicht, sondern liest
  den Code direkt aus dem `Location`-Header der Antwort. Unter der Redirect-URI muss deshalb nichts
  lauschen – das beseitigt auch die bekannten Probleme mit `localhost` in Docker-Containern.

Benutzername, Passwort, Code Challenge und Token liegen verschlüsselt in den Node-RED-Credentials
und landen nie in der Flow-Datei.

---

## Erste Schritte

**Alle Werte ansehen:** *Viessmann lesen* mit Auswahl *Alle Datenpunkte* und Ausgabe *Rohdaten* an
eine Debug-Node. Das zeigt genau, was deine Anlage liefert – auch das beste Mittel für Fehlerberichte.

**Gezielt Werte holen:** Auswahl *Nur ausgewählte Datenpunkte* → *Datenpunkte vom Gerät laden* → aus
der Liste wählen. ✎ markiert beschreibbare, ⚠ veraltete Einträge.

**An MQTT weitergeben:** Ausgabe *Eine Nachricht je Datenpunkt*, Topic-Präfix z. B. `heizung`:

```
heizung/heating.sensors.temperature.outside → 17.3
heizung/heating.dhw.temperature.main        → 58
```

**Etwas verstellen:** In der Konfiguration *Schreibzugriff erlauben* setzen, eine
*Viessmann schreiben*-Node mit aktiviertem *Testlauf* einfügen, auslösen, Ergebnis prüfen, dann
Testlauf abschalten.

Ein fertiger Flow liegt unter [`examples/viessmann-basis.json`](examples/viessmann-basis.json) und
lässt sich im Editor über *Import* einfügen.

---

## Beispiele zum Kopieren

```javascript
// Warmwasser-Solltemperatur (Grenzen kommen von der API, meist 10–60 °C)
msg.feature = "heating.dhw.temperature.main";
msg.command = "setTargetTemperature";
msg.payload = { temperature: 55 };

// Betriebsart des Heizkreises 0
msg.feature = "heating.circuits.0.operating.modes.active";
msg.command = "setMode";
msg.payload = { mode: "dhwAndHeating" };

// Heizkurve
msg.feature = "heating.circuits.0.heating.curve";
msg.command = "setCurve";
msg.payload = { slope: 0.6, shift: 2 };

// Einmalige Warmwasserladung starten / beenden
msg.feature = "heating.dhw.oneTimeCharge";
msg.command = "activate";     // bzw. "deactivate"
msg.payload = {};

// Zirkulationspumpe dauerhaft aus (leerer Zeitplan)
msg.feature = "heating.dhw.pumps.circulation.schedule";
msg.command = "setSchedule";
msg.payload = { newSchedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };

// Urlaubsprogramm
msg.feature = "heating.operating.programs.holiday";
msg.command = "schedule";
msg.payload = { start: "2026-12-20", end: "2027-01-03" };
```

Welche Befehle und Werte deine Anlage tatsächlich annimmt, zeigt die Schreib-Node nach
*Beschreibbare Datenpunkte laden* direkt im Dialog an.

---

## Nicht jedes Gerät kann alles

Die API liefert für jede Anlage dieselbe große Liste und markiert mit `isEnabled: false`, was das
Gerät nicht unterstützt.

| Zustand | Bedeutung |
|---|---|
| `available: true` | Gerät unterstützt den Datenpunkt **und** liefert Werte |
| `isEnabled: false` | Gerät hat diese Funktion nicht (z. B. Solar ohne Solaranlage) |
| `empty: true` | Datenpunkt vorhanden, aber gerade ohne Inhalt |

Standardmäßig gibt die Lese-Node nur verfügbare Datenpunkte aus. Veraltete Einträge nennen ihren
Nachfolger, etwa `heating.dhw.sensors.temperature.hotWaterStorage` →
`heating.dhw.sensors.temperature.dhwCylinder`.

---

## Schutzmechanismen beim Schreiben

| Mechanismus | Wirkung |
|---|---|
| Standardmäßig aus | Ohne Freigabe in der Konfiguration wird nichts geschrieben |
| Positivliste durch die API | Nur Befehle, die das Gerät für diesen Datenpunkt anbietet |
| Wertebereiche | Min, Max, Schrittweite, Auswahllisten und Muster werden vorab geprüft |
| Nur bei Änderung | Liegt der Zielwert schon an, passiert nichts (`skipped: true`) |
| Mindestabstand | Einstellbare Sperre gegen Schreibschleifen |
| Testlauf | Alles prüfen, nichts senden |
| Getrennte Ausgänge | Antworten und Fehler laufen nie im Datenstrom der Messwerte |

---

## Abfrageintervall und Rate Limit

Die API hat ein Tageslimit, und die Anlage liefert ohnehin nur alle paar Minuten neue Werte.
Empfohlen sind **300 Sekunden** Intervall und **30 Sekunden** Cache. Mehrere Lese-Nodes sollten sich
**eine** Konfiguration teilen – der gemeinsame Cache holt die Daten dann nur einmal.

---

## Symptom → Ursache → Lösung

| Symptom | Ursache | Lösung |
|---|---|---|
| „Viessmann verlangt eine interaktive Anmeldung“ | reCAPTCHA im Portal aktiv oder Redirect-URI weicht ab | reCAPTCHA ausschalten, Redirect-URI zeichengenau abgleichen |
| „Anmeldung abgelehnt (HTTP 401)“ | Benutzername oder Passwort falsch | ViCare-Zugangsdaten prüfen |
| „Viessmann lehnt die Anmeldung ab: … redirect …“ | Redirect-URI stimmt nicht | Exakt wie im Portal eintragen, inkl. `http`/`https`, Port und Pfad |
| „Code-Einlösung fehlgeschlagen“ | Redirect-URI oder Client-ID abweichend | Beide mit dem Portal abgleichen |
| „Die Code Challenge ist ungültig“ | zu kurz oder unerlaubte Zeichen | *erzeugen* klicken oder Feld leeren |
| „Keine Installation gefunden“ | Anlage nicht in ViCare registriert, anderes Konto | ViCare-App prüfen |
| `HTTP 429` | zu viele Abfragen | Intervall und Cache erhöhen |
| `Zeitüberschreitung` | kein Internet aus dem Container | `docker exec node-red ping -c1 api.viessmann-climatesolutions.com` |
| „Schreiben ist deaktiviert“ | Freigabe fehlt | *Schreibzugriff erlauben* setzen |
| Neue Felder fehlen im Editor | Browser-Cache | Strg+F5 |

---

## Entwicklung

```bash
npm test      # 44 Tests gegen einen simulierten Viessmann-Server inkl. Identity Provider
npm run lint  # Syntax, Editor-Dateien, Paketangaben und Beispiel-Flows
```

Der Simulator bildet auch die Sonderfälle ab: Erststart ohne Token, abgelehntes Refresh Token,
falsches Passwort, aktives reCAPTCHA, abweichende Redirect-URI, rotierende Token, HTTP 401,
Rate Limit und Netzwerkfehler.

---

## Veröffentlichung

```bash
git init
git add -A
git commit -m "0.3.0: vollautomatische Anmeldung"
gh repo create impact0815/node-red-contrib-viessmann --private --source=. --push

# nach dem Test im Echtbetrieb
gh repo edit impact0815/node-red-contrib-viessmann --visibility public
npm publish --access public
```

Sobald das Paket auf npm liegt, erscheint es automatisch in der
[Node-RED Flow Library](https://flows.nodered.org) und in der Palette.

---

## Quellen

- [Rustimation.eu – Viessmann API und Node-Red](https://www.rustimation.eu/index.php/1_zugang_api/) – die Grundlage für den API-Zugang
- [Viessmann API Dokumentation](https://api.viessmann-climatesolutions.com/documentation)
- [Viessmann Developer Portal](https://app.developer.viessmann-climatesolutions.com)

Dieses Projekt steht in keiner Verbindung zur Viessmann Climate Solutions SE. Alle Marken gehören
ihren jeweiligen Inhabern.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
