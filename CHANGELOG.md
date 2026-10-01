# Änderungsverlauf

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [0.3.1] – 2026-09-30

Erste im Echtbetrieb getestete und auf npm veröffentlichte Version.

### Geändert
- **Paketname mit Scope:** `@impact0815/node-red-contrib-viessmann`, wie es die Node-RED-Richtlinien
  für neue Pakete verlangen. Die Node-Typen (`viessmann-config`, `viessmann-read`, `viessmann-write`)
  sind unverändert – bestehende Flows und Verbindungen funktionieren weiter.
- Veröffentlichung über npm Trusted Publishing (OIDC) statt eines gespeicherten Tokens.

### Behoben
- **„Invalid redirection URI“ trotz korrekter Adresse:** Die Autorisierungs-URL wird jetzt exakt wie
  im bewährten Rustimation-Flow aufgebaut (Redirect-URI unkodiert, Scope mit `%20`). Die
  standardkonforme Kodierung lehnt der Viessmann-Server ab.
- Leerzeichen vor oder nach der Redirect-URI werden entfernt.
- CI: Testaufruf funktioniert jetzt auch mit Node 18 und 20.

### Verbessert
- Deutlicher Haftungsausschluss (DE/EN) in README und Editor-Hilfe.
- Fehlermeldungen zur Redirect-URI nennen die tatsächlich gesendete Adresse (`REDIRECT_URI_MISMATCH`).
- „Nur bei Änderung schreiben“ gilt jetzt auch für Zeitpläne (`setSchedule`); der Vergleich ist
  unabhängig von der Reihenfolge der Tage und Einträge.
- Die Schreib-Node zeigt bei Zeitplänen die Grenzen Modi, Einträge pro Tag und Raster an.
- Hilfetexte deutlich erweitert: Auswertung in Function-Nodes, Durchreichen von Nachrichten-
  Eigenschaften, Zeitpläne, veraltete Datenpunkte, vollständige Fehlercodes.

### Neu
- Vier Beispiel-Flows unter *Import → Beispiele*: Erste Schritte, Abfrage → MQTT,
  Zirkulationspumpe temporär, Warmwasser temporär.
- `npm run lint` prüft zusätzlich Beispiel-Flows (Verbindungen, Function-Code, keine Zugangsdaten),
  den Paketnamen mit Scope, den CHANGELOG-Eintrag zur Version und den Haftungsausschluss.

## [0.3.0] – 2026-09-30

### Neu
- **Vollautomatische Anmeldung ohne Nutzerinteraktion.** Eingetragen werden nur Client-ID,
  Redirect-URI, optional die Code Challenge sowie ViCare-Benutzername und -Passwort.
- Richtige Reihenfolge beim Erststart: ohne Refresh Token direkt anmelden; abgelehntes Refresh
  Token führt zur automatischen Neuanmeldung, Netzwerkfehler nicht.
- Authorization Code wird direkt aus dem `Location`-Header gelesen – kein `http in`-Node nötig.
- Code Challenge im Dialog erzeugbar, wird geprüft oder automatisch gebildet.
- „Verbindung testen“ funktioniert vor dem ersten Deploy.

### Entfernt
- Browser-Assistent und Hilfsskript für das Refresh Token (durch die Automatik überflüssig).

## [0.2.0] – 2026-09-29
- Anmeldung per Browser-Assistent im Editor.

## [0.1.0] – 2026-09-29
- Erste Version: Konfigurations-, Lese- und Schreib-Node, Auto-Discovery, Validierung gegen
  API-Constraints, Tests gegen einen Simulator.
- Der Zugangsweg zur API folgt der Anleitung von
  [Rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).
