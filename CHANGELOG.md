# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning according to [Semantic Versioning](https://semver.org/).
German summary below each entry / Deutsche Kurzfassung jeweils darunter.

## [0.4.1] – 2026-10-01

### Improved
- Improved multilingual support (en-US as default locale).
- Harmonized locale structure with node-red-contrib-alphaess-modbus.
- Moved disclaimer to the beginning of the documentation.
- Improved README and help text consistency.

**DE:** Standardsprache en-US, Locales an AlphaESS angeglichen, Haftungsausschluss an den Anfang verschoben und Dokumentation vereinheitlicht.

## [0.4.0] – 2026-10-01

### Added
- **English and German.** Editor dialogs, help texts, node status, error and validation messages
  follow the Node-RED language setting. Implemented with the official Node-RED i18n mechanism
  (`nodes/locales/<lang>/`), English is the fallback for all other languages.
- `README.md` in English, `README.de.md` in German.
- `test/i18n.test.js`: English and German must have identical keys and placeholders; every key used
  in editor and runtime must exist; help texts must exist in both languages.
- Example 02 additionally publishes burner modulation, hours and starts.

### Changed
- Locale catalogs use `en-US` as the explicit default/reference locale; German remains in `de` and
  both catalogs are checked for identical keys and placeholders.
- The disclaimer is now the first section in both READMEs and in every localized Node-RED help page.
- English UI wording was normalized to US English.
- Package name with scope: `@impact0815/node-red-contrib-viessmann` (Node-RED naming guidelines).
  Node types are unchanged – existing flows and connections keep working.
- Errors now carry a translatable `key` plus `params`; the machine-readable `code` values are
  unchanged.
- Example flows: node names in English, descriptions bilingual. Example 02 uses English field names
  and `null` for values the device does not deliver.
- Publishing via npm Trusted Publishing (OIDC) instead of a stored token.
- Code comments in English.

### Fixed
- CI: the test call now works with Node 18 and 20.

**DE:** Zweisprachig (Deutsch/Englisch) für Dialoge, Hilfe, Status- und Fehlermeldungen über das
offizielle Node-RED-i18n; `en-US` als Standard und Rückfallsprache; Haftungsausschluss am Anfang aller
README- und Hilfetexte; README auf Englisch und Deutsch; Paketname mit Scope; Beispiel-Flows mit
englischen Node-Namen und zweisprachigen Beschreibungen; Veröffentlichung per Trusted Publishing.

## [0.3.1] – 2026-09-30

### Fixed
- **"Invalid redirection URI" despite a correct address:** the authorize URL is now built exactly
  like in the proven Rustimation flow (redirect URI unencoded, scope with `%20`).
- Whitespace around the redirect URI is removed.

### Improved
- Clear disclaimer (DE/EN) in README and editor help.
- Redirect URI errors show the address that was actually sent (`REDIRECT_URI_MISMATCH`).
- "Only write on change" also applies to schedules (`setSchedule`), independent of order.
- Write node shows schedule limits (modes, entries per day, grid).
- Four example flows: first steps, read → MQTT, circulation pump temporary, hot water temporary.

**DE:** Behebt „Invalid redirection URI“; Haftungsausschluss; Zeitplan-Vergleich; vier Beispiel-Flows.

## [0.3.0] – 2026-09-30

### Added
- **Fully automatic login without user interaction** – only client ID, redirect URI, optional code
  challenge, ViCare username and password are needed.
- Correct order on first start: without refresh token log in directly; a rejected refresh token
  leads to an automatic new login, network errors do not.
- Authorization code read directly from the `Location` header – no `http in` node required.
- "Test connection" works before the first deploy.

**DE:** Vollautomatische Anmeldung ohne Nutzerinteraktion, richtige Reihenfolge beim Erststart.

## [0.2.0] – 2026-09-29
- Login via a browser assistant in the editor. / Anmeldung per Browser-Assistent.

## [0.1.0] – 2026-09-29
- First version: configuration, read and write node, auto-discovery, validation against API
  constraints, tests against a simulator. API access based on the guide by
  [Rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).
  / Erste Version.
