# Änderungsverlauf

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
Versionierung nach [Semantic Versioning](https://semver.org/lang/de/).

## [0.3.0] – 2026-09-30

### Neu
- **Vollautomatische Anmeldung ohne Nutzerinteraktion.** Eingetragen werden nur Client-ID,
  Redirect-URI, optional die Code Challenge sowie ViCare-Benutzername und -Passwort. Die Node
  holt den Authorization Code selbst per Basic Auth, tauscht ihn gegen die Token und erneuert
  diese dauerhaft.
- **Richtige Reihenfolge beim Erststart:** Ohne Refresh Token wird direkt angemeldet, statt
  zuerst eine Erneuerung mit leerem Token zu versuchen. Wird ein Refresh Token später abgelehnt,
  meldet sich die Node automatisch neu an. Bei Netzwerkfehlern dagegen nicht.
- Der Authorization Code wird direkt aus dem `Location`-Header gelesen. Unter der Redirect-URI
  muss nichts lauschen, ein `http in`-Node ist überflüssig.
- Code Challenge: im Dialog erzeugbar, wird geprüft (43–128 zulässige Zeichen) oder bei leerem
  Feld automatisch gebildet.
- „Verbindung testen“ funktioniert bereits vor dem ersten Deploy und nennt den Schritt, an dem
  ein Fehler auftritt.
- Verständliche Fehlermeldungen für falsches Passwort, aktives reCAPTCHA und abweichende
  Redirect-URI.

### Entfernt
- Der Browser-Assistent „Mit Viessmann verbinden“ und das Hilfsskript `get-refresh-token.js`
  sind durch die vollautomatische Anmeldung überflüssig.

## [0.2.0] – 2026-09-29
- Anmeldung per Browser-Assistent im Editor.

## [0.1.0] – 2026-09-29
- Erste Version: Konfigurations-, Lese- und Schreib-Node, Auto-Discovery, Validierung gegen
  API-Constraints, Tests gegen einen Simulator.
- Der Zugangsweg zur API folgt der Anleitung von
  [Rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).
