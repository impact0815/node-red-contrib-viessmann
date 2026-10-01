# @impact0815/node-red-contrib-viessmann

[English](README.md) · **Deutsch**

## Haftungsausschluss

> **⚠️ Nutzung auf eigene Gefahr – ohne Gewähr.**
> Dieses Projekt ist ein privates Open-Source-Projekt und steht in keiner Verbindung zur
> Viessmann Climate Solutions SE. Es wird ohne jede Gewährleistung bereitgestellt. Schreibbefehle
> verändern die Einstellungen deiner Heizungsanlage. Für Schäden an Anlage, Gebäude oder Daten,
> Komfortverlust oder Kosten wird keine Haftung übernommen. Die Viessmann-API kann sich jederzeit
> ändern, eingeschränkt oder abgeschaltet werden. Prüfe Schreibbefehle zuerst im Testlauf und
> behalte die Anlage im Blick. Details: [LICENSE](LICENSE).

---

Node-RED-Nodes für die **Viessmann IoT API** (ViCare / Vitoconnect): vollautomatische Anmeldung,
automatische Erkennung der verfügbaren Datenpunkte, Lesen und abgesichertes Schreiben.
Editor, Hilfetexte und Meldungen auf **Deutsch und Englisch**.

[![CI](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml/badge.svg)](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40impact0815%2Fnode-red-contrib-viessmann.svg)](https://www.npmjs.com/package/@impact0815/node-red-contrib-viessmann)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Dank an Rustimation.eu

Dieses Paket gäbe es nicht ohne die ausführliche und geduldig gepflegte Anleitung
**„Viessmann API und Node-Red – Teil 2 – API Zugriff“** auf
[rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).

Dort ist der komplette Weg vom Viessmann-Developer-Konto über Client-ID, Code Challenge und
Authorization Code bis zum Refresh Token Schritt für Schritt beschrieben – inklusive der Stolpersteine
bei Docker, Home Assistant, ioBroker und Homematic. Diese Vorarbeit hat den Zugang zur API überhaupt
erst nachvollziehbar gemacht. **Herzlichen Dank dafür.**

Was hier hinzukommt: Der dort aus mehreren Nodes zusammengesteckte Ablauf steckt jetzt in einer
einzigen Konfigurations-Node – ohne `http in`-Node, ohne manuelles Auslösen und mit der richtigen
Reihenfolge beim allerersten Start.

---

## Was das Paket kann

| Node | Aufgabe |
|---|---|
| **Viessmann API** (Konfiguration) | Vollautomatische Anmeldung und Token-Erneuerung, gemeinsamer Datencache, Freigabe für Schreibzugriffe |
| **Viessmann lesen** | Datenpunkte abfragen, filtern, in vier Formaten ausgeben, Status und Fehler getrennt |
| **Viessmann schreiben** | Befehle ausführen, mit Prüfung gegen die echten Wertebereiche der API |

**Kernidee:** Es gibt keine fest eingebaute Datenpunktliste. Alles wird aus der Antwort der API
abgeleitet – auch die Schreibbefehle samt Minimum, Maximum, Schrittweite und Auswahllisten. Damit
funktioniert das Paket mit jedem Viessmann-Gerät, das über die API erreichbar ist, und zeigt jedem
Nutzer nur das, was **seine** Anlage tatsächlich kann.

---

## Installation

### Über die Node-RED-Palette

Menü → *Palette verwalten* → *Installieren* → `@impact0815/node-red-contrib-viessmann`

### Per Kommandozeile

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-viessmann
```

Im Docker-Container:

```bash
docker exec node-red npm install --prefix /data @impact0815/node-red-contrib-viessmann
docker restart node-red
```

Danach den Editor im Browser mit **Strg+F5** neu laden.

Voraussetzungen: Node-RED 3 oder neuer, Node.js 18 oder neuer. Keine weiteren Abhängigkeiten.

> **Umstieg von einer lokal installierten Version:** Vorher die alte Installation entfernen
> (`npm uninstall node-red-contrib-viessmann` im Node-RED-Verzeichnis), sonst meldet Node-RED doppelt
> registrierte Node-Typen. Flows und gespeicherte Verbindungen bleiben erhalten.

---

## Einrichten

### 1. Einmalig im Viessmann Developer Portal

1. Die Anlage muss in der **ViCare-App** registriert sein und dort funktionieren.
2. Mit denselben Zugangsdaten bei
   [app.developer.viessmann-climatesolutions.com](https://app.developer.viessmann-climatesolutions.com) anmelden.
3. Unter *Your Clients* einen Client anlegen:
   - **Google reCAPTCHA ausschalten** – Pflicht, sonst ist keine automatische Anmeldung möglich.
   - **Redirect URI** eintragen, z. B. `http://localhost:1880/authcode`.
4. Speichern – die **Client-ID** wird angezeigt.

Wer den Zugang schon nach der Rustimation-Anleitung eingerichtet hat, übernimmt einfach die
vorhandene Client-ID, Redirect-URI und Code Challenge.

### 2. In Node-RED

Eine *Viessmann lesen*-Node auf die Arbeitsfläche ziehen, bei *Verbindung* eine neue Konfiguration
anlegen und eintragen:

| Feld | Inhalt |
|---|---|
| **Client-ID** | aus dem Developer Portal |
| **Redirect-URI** | aus dem Portal **kopieren** – muss zeichengenau übereinstimmen |
| **Code Challenge** | optional – vorhandene übernehmen, mit *erzeugen* neu anlegen oder leer lassen |
| **Benutzername** | E-Mail-Adresse des ViCare-Kontos |
| **Passwort** | Passwort des ViCare-Kontos |

**Verbindung testen** klicken – der Test funktioniert schon vor dem ersten Deploy und meldet
Installation, Gateway und Anzahl der Datenpunkte, etwa *„45 von 106 verfügbar, 13 beschreibbar“*.
Dann **Fertig** und **Deploy**. Mehr ist nicht zu tun.

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

Das Access Token wird kurz vor Ablauf erneuert, nach einem HTTP 401 sofort. Bei Netzwerkfehlern
meldet sich die Node bewusst nicht neu an.

Zwei Unterschiede zum ursprünglichen Rustimation-Flow:

- **Reihenfolge beim Erststart:** Beim allerersten Start gibt es noch kein Refresh Token. Die Node
  versucht dann gar nicht erst eine Erneuerung mit leerem Token, sondern meldet sich direkt an.
- **Kein `http in`-Node nötig:** Die Node folgt der Weiterleitung von Viessmann nicht, sondern liest
  den Code direkt aus der Antwort. Unter der Redirect-URI muss deshalb nichts lauschen – die bekannten
  `localhost`-Probleme mit Docker, Home Assistant oder ioBroker entfallen.

Benutzername, Passwort, Code Challenge und Token liegen verschlüsselt in den Node-RED-Credentials und
landen nie in der Flow-Datei oder einem Export.

---

## Sprache

Dialoge, Hilfetexte, Status- und Fehlermeldungen richten sich nach der in Node-RED eingestellten
Sprache (*Benutzereinstellungen → Ansicht → Sprache*). Der vollständige Katalog **en-US** ist Standard
und Rückfallsprache; **de** enthält die deutsche Übersetzung. Weitere Übersetzungen sind willkommen –
siehe [Mitarbeit](#mitarbeit).

---

## Beispiel-Flows

Im Editor unter *Import → Beispiele → @impact0815/node-red-contrib-viessmann*. Nach dem Import in
jeder Viessmann-Node die eigene Verbindung auswählen. Die Beschreibungen in den Flows sind
zweisprachig, die Node-Namen englisch.

| Beispiel | Inhalt |
|---|---|
| **01 first steps** | Rohdaten der eigenen Anlage ansehen; Schreiben im Testlauf (sendet nichts) |
| **02 read → MQTT** | Alle 5 Minuten lesen und als `viessmann/sensors`, `/boiler`, `/dhw`, `/circuit` aufbereiten – eine erweiterbare Tabelle statt vieler Function-Nodes |
| **03 circulation pump temporary** | Aktuellen Plan sichern, 20 Minuten Tagesplan, danach automatisch zurück; AUS und Wiederherstellen per Knopf oder Link-In |
| **04 hot water temporary** | Dasselbe für die Warmwasserbereitung (`heating.dhw.schedule`) |

Die Beispiele 03 und 04 sind gegen Mehrfachauslösung abgesichert: Ein erneutes AN innerhalb der
20 Minuten verlängert die Zeit, überschreibt aber nicht die Sicherung des eigentlichen Plans.

---

## Lesen

**Alle Werte ansehen:** Auswahl *Alle Datenpunkte*, Ausgabe *Rohdaten* – zeigt genau, was die
eigene Anlage liefert. Das ist auch das beste Mittel für Fehlerberichte.

**Gezielt Werte holen:** Auswahl *Nur ausgewählte Datenpunkte* → *Datenpunkte vom Gerät laden*.
✎ markiert beschreibbare, ⚠ veraltete Einträge.

**In einer Function-Node auswerten** (Ausgabe *Objekt je Datenpunkt*):

```javascript
const f = msg.payload["heating.sensors.temperature.outside"];
const aussen = f ? f.values.value : null;   // null, wenn das Gerät den Wert nicht liefert
```

**An MQTT weitergeben:** Ausgabe *Eine Nachricht je Datenpunkt*, Topic-Präfix z. B. `heizung`:

```
heizung/heating.sensors.temperature.outside → 17.3
heizung/heating.dhw.temperature.main        → 58
```

Eigenschaften der eingehenden Nachricht (z. B. `msg.action`) werden durchgereicht. So lässt sich
„erst lesen, dann entscheiden“ in einem Flow abbilden.

---

## Schreiben

In der Konfiguration **Schreibzugriff erlauben** aktivieren. Welche Befehle die eigene Anlage
anbietet, zeigt die Schreib-Node nach *Beschreibbare Datenpunkte laden* – samt erlaubter Werte.
Neue Befehle am besten zuerst mit aktiviertem **Testlauf** ausprobieren.

```javascript
// Warmwasser-Solltemperatur (Grenzen kommen von der API, meist 10–60 °C)
msg.feature = "heating.dhw.temperature.main";
msg.command = "setTargetTemperature";
msg.payload = { temperature: 55 };

// Warmwasser sofort einmalig aufheizen (falls vom Gerät angeboten)
msg.feature = "heating.dhw.oneTimeCharge";
msg.command = "activate";
msg.payload = {};

// Betriebsart des Heizkreises 0
msg.feature = "heating.circuits.0.operating.modes.active";
msg.command = "setMode";
msg.payload = { mode: "dhwAndHeating" };

// Heizkurve
msg.feature = "heating.circuits.0.heating.curve";
msg.command = "setCurve";
msg.payload = { slope: 0.6, shift: 2 };

// Zirkulationspumpe dauerhaft aus (leerer Zeitplan)
msg.feature = "heating.dhw.pumps.circulation.schedule";
msg.command = "setSchedule";
msg.payload = { newSchedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };

// Urlaubsprogramm
msg.feature = "heating.operating.programs.holiday";
msg.command = "schedule";
msg.payload = { start: "2026-12-20", end: "2027-01-03" };
```

| Schutzmechanismus | Wirkung |
|---|---|
| Standardmäßig aus | Ohne Freigabe in der Konfiguration wird nichts geschrieben |
| Positivliste durch die API | Nur Befehle, die das Gerät für diesen Datenpunkt anbietet |
| Wertebereiche | Min, Max, Schrittweite, Auswahllisten und Muster werden vorab geprüft |
| Nur bei Änderung | Liegt der Zielwert schon an, passiert nichts (`skipped: true`) – auch bei Zeitplänen |
| Mindestabstand | Einstellbare Sperre gegen Schreibschleifen |
| Testlauf | Alles prüfen, nichts senden |
| Getrennte Ausgänge | Antworten und Fehler laufen nie im Datenstrom der Messwerte |

Zeitpläne werden immer vollständig ersetzt (meist höchstens 4 Einträge pro Tag, 10-Minuten-Raster).
Ein geänderter Warmwasser-Zeitplan startet das Aufheizen nur, wenn der Speicher unter dem Sollwert
liegt; für sofortiges Aufheizen gibt es `heating.dhw.oneTimeCharge`.

---

## Nicht jedes Gerät kann alles

Die API liefert für jede Anlage dieselbe große Liste und markiert mit `isEnabled: false`, was das
Gerät nicht unterstützt.

| Zustand | Bedeutung |
|---|---|
| `available: true` | Gerät unterstützt den Datenpunkt **und** liefert Werte |
| `isEnabled: false` | Gerät hat diese Funktion nicht (z. B. Solar ohne Solaranlage) |
| `empty: true` | Datenpunkt vorhanden, aber gerade ohne Inhalt |

Veraltete Datenpunkte nennen ihren Nachfolger, etwa `heating.dhw.sensors.temperature.hotWaterStorage`
→ `heating.dhw.sensors.temperature.dhwCylinder` oder `heating.boiler.serial` → `device.serial`.
Eigene Auswertungen sollten zuerst den neuen, dann den alten Namen probieren – so macht es auch
Beispiel 02.

---

## Abfrageintervall und Rate Limit

Die API hat ein Tageslimit, und die Anlage liefert ohnehin nur alle paar Minuten neue Werte.
Empfohlen sind **300 Sekunden** Intervall und **30 Sekunden** Cache. Mehrere Lese-Nodes sollten sich
**eine** Verbindung teilen – der gemeinsame Cache holt die Daten dann nur einmal. Beim Umstieg von
einem alten Flow die alten Abfrage- und Token-Nodes deaktivieren, sonst wird doppelt abgefragt.

---

## Symptom → Ursache → Lösung

| Symptom | Ursache | Lösung |
|---|---|---|
| „Invalid redirection URI“ | Redirect-URI weicht vom Portal ab | Die Meldung zeigt die gesendete Adresse – mit dem Portal vergleichen und von dort kopieren |
| „Viessmann verlangt eine interaktive Anmeldung“ | reCAPTCHA im Portal aktiv, falsche Zugangsdaten oder Redirect-URI weicht ab | reCAPTCHA ausschalten, Zugangsdaten und Redirect-URI prüfen |
| „Anmeldung abgelehnt (HTTP 401)“ | Benutzername oder Passwort falsch | ViCare-Zugangsdaten prüfen |
| „Einlösen des Autorisierungscodes fehlgeschlagen“ | Redirect-URI oder Client-ID abweichend | Beide mit dem Portal abgleichen |
| „Die Code Challenge ist ungültig“ | zu kurz oder unerlaubte Zeichen | *erzeugen* klicken oder Feld leeren |
| „Keine Installation gefunden“ | Anlage nicht in ViCare registriert, anderes Konto | ViCare-App prüfen |
| `HTTP 429` | zu viele Abfragen | Intervall und Cache erhöhen, alte Flows abschalten |
| Zeitüberschreitung | kein Internet aus dem Container | `docker exec node-red ping -c1 api.viessmann-climatesolutions.com` |
| „Schreiben ist deaktiviert“ | Freigabe fehlt | *Schreibzugriff erlauben* setzen |
| Verbindung im importierten Flow fehlt | Beispiele enthalten bewusst keine Verbindung | In jeder Viessmann-Node die eigene Verbindung wählen |
| Node-Typen doppelt registriert | alte lokale Installation noch vorhanden | `npm uninstall node-red-contrib-viessmann`, Node-RED neu starten |
| Texte in falscher Sprache | Spracheinstellung von Node-RED | *Benutzereinstellungen → Ansicht → Sprache*, dann Browser neu laden |
| Neue Felder fehlen im Editor | Browser-Cache | Strg+F5 |
| Geschriebener Wert erscheint nicht beim Lesen | Anlage braucht ein bis zwei Minuten | kurz warten |

---

## Mitarbeit

```bash
npm test      # Tests gegen einen simulierten Viessmann-Server inkl. Identity Provider und Übersetzungen
npm run lint  # Syntax, Editor-Dateien, Sprachdateien, Paketangaben und Beispiel-Flows
```

Der Simulator in `test/mock-server.js` bildet auch die Sonderfälle ab: Erststart ohne Token,
abgelehntes Refresh Token, falsches Passwort, aktives reCAPTCHA, abweichende oder kodierte
Redirect-URI, rotierende Token, HTTP 401, Rate Limit und Netzwerkfehler. `test/i18n.test.js` stellt
sicher, dass Deutsch und Englisch immer dieselben Schlüssel und Platzhalter haben.

**Weitere Sprache hinzufügen:** `nodes/locales/en-US/` nach `nodes/locales/<code>/` kopieren
(z. B. `fr`), die drei `.json`- und drei `.html`-Dateien übersetzen und den Code in `LANGS` in
`test/i18n.test.js` und `tools/lint.js` ergänzen.

Fehlerberichte und Wünsche bitte als
[Issue](https://github.com/impact0815/node-red-contrib-viessmann/issues) – idealerweise mit den
Rohdaten der eigenen Anlage (Beispiel 01), bei denen Seriennummern unkenntlich gemacht sind.

---

## Quellen

- [Rustimation.eu – Viessmann API und Node-Red](https://www.rustimation.eu/index.php/1_zugang_api/) – die Grundlage für den API-Zugang
- [Viessmann API Dokumentation](https://api.viessmann-climatesolutions.com/documentation)
- [Viessmann Developer Portal](https://app.developer.viessmann-climatesolutions.com)

## Lizenz

MIT – siehe [LICENSE](LICENSE). Die Lizenz schließt Gewährleistung und Haftung ausdrücklich aus.
