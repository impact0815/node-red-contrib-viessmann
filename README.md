# @impact0815/node-red-contrib-viessmann

**English** · [Deutsch](README.de.md)

## Disclaimer

> **⚠️ Use at your own risk – no warranty.**
> This is an unofficial community project and is not affiliated with Viessmann Climate Solutions SE.
> It is provided "as is", without warranty of any kind. Write commands change the settings of your
> heating system. The authors accept no liability for damage to the system, building or data, loss of
> comfort, or costs. The Viessmann API may change, be restricted, or be discontinued at any time.
> Test write commands in dry-run mode first and monitor your system. See [LICENSE](LICENSE).

---

Node-RED nodes for the **Viessmann IoT API** (ViCare / Vitoconnect): fully automatic login,
automatic discovery of the available data points, reading and safeguarded writing.
Editor, help texts and messages in **English and German**.

[![CI](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml/badge.svg)](https://github.com/impact0815/node-red-contrib-viessmann/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40impact0815%2Fnode-red-contrib-viessmann.svg)](https://www.npmjs.com/package/@impact0815/node-red-contrib-viessmann)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Thanks to Rustimation.eu

This package would not exist without the detailed and patiently maintained guide
**"Viessmann API und Node-Red – Teil 2 – API Zugriff"** on
[rustimation.eu](https://www.rustimation.eu/index.php/1_zugang_api/).

It describes the complete path from the Viessmann developer account via client ID, code challenge
and authorization code to the refresh token step by step – including the pitfalls with Docker,
Home Assistant, ioBroker and Homematic. That groundwork made access to the API understandable in the
first place. **Many thanks for it.**

What this package adds: the flow built there from several nodes now lives in one single configuration
node – without an `http in` node, without manual triggering and with the correct order on the very
first start.

---

## What the package does

| Node | Purpose |
|---|---|
| **Viessmann API** (configuration) | Fully automatic login and token renewal, shared data cache, permission for write access |
| **Viessmann read** | Query data points, filter, output in four formats, status and errors separated |
| **Viessmann write** | Execute commands, checked against the real value ranges of the API |

**Core idea:** there is no built-in list of data points. Everything is derived from the API
response – including the write commands with minimum, maximum, step size and allowed values. This
makes the package work with any Viessmann device reachable through the API and shows every user only
what **their** system actually supports.

---

## Installation

### Via the Node-RED palette

Menu → *Manage palette* → *Install* → `@impact0815/node-red-contrib-viessmann`

### Command line

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-viessmann
```

In a Docker container:

```bash
docker exec node-red npm install --prefix /data @impact0815/node-red-contrib-viessmann
docker restart node-red
```

Then reload the editor in the browser with **Ctrl+F5**.

Requirements: Node-RED 3 or newer, Node.js 18 or newer. No further dependencies.

> **Switching from a locally installed copy:** remove the old installation first
> (`npm uninstall node-red-contrib-viessmann` in the Node-RED directory), otherwise Node-RED reports
> duplicate node types. Flows and stored connections are kept.

---

## Setup

### 1. Once in the Viessmann Developer Portal

1. The system must be registered in the **ViCare app** and work there.
2. Log in with the same credentials at
   [app.developer.viessmann-climatesolutions.com](https://app.developer.viessmann-climatesolutions.com).
3. Create a client under *Your Clients*:
   - **Disable Google reCAPTCHA** – mandatory, otherwise no automatic login is possible.
   - Enter a **redirect URI**, e.g. `http://localhost:1880/authcode`.
4. Save – the **client ID** is shown.

If you already set up access following the Rustimation guide, simply reuse your existing client ID,
redirect URI and code challenge.

### 2. In Node-RED

Drag a *Viessmann read* node onto the workspace, create a new configuration under *Connection* and
enter:

| Field | Content |
|---|---|
| **Client ID** | from the Developer Portal |
| **Redirect URI** | **copy** it from the portal – must match exactly |
| **Code challenge** | optional – reuse an existing one, *generate* a new one or leave empty |
| **Username** | e-mail address of the ViCare account |
| **Password** | password of the ViCare account |

Click **Test connection** – the test works even before the first deploy and reports installation,
gateway and number of data points, e.g. *"45 of 106 available, 13 writable"*. Then **Done** and
**Deploy**. That's all.

### What happens automatically

```
Refresh token present?
 ├─ yes → get access token with it
 │          └─ rejected by Viessmann? → continue as "no"
 └─ no  → log in with user + password (GET /authorize, Basic Auth)
            → read the authorization code from the redirect
            → exchange code + code challenge for access and refresh token
            → store the refresh token encrypted
```

The access token is renewed shortly before expiry, and immediately after an HTTP 401. On network
errors the node deliberately does not log in again.

Two differences to the original Rustimation flow:

- **Order on first start:** on the very first start there is no refresh token yet. The node does not
  even try a renewal with an empty token but logs in directly.
- **No `http in` node needed:** the node does not follow the Viessmann redirect but reads the code
  directly from the response. Nothing has to listen at the redirect URI – the known `localhost`
  problems with Docker, Home Assistant or ioBroker disappear.

Username, password, code challenge and tokens are stored encrypted in the Node-RED credentials and
never end up in the flow file or an export.

---

## Language

Dialogs, help texts, status and error messages follow the language set in Node-RED
(*User settings → View → Language*). The complete **en-US** catalog is the default and fallback;
**de** provides the German translation. Translations for further languages are welcome – see
[Contributing](#contributing).

---

## Example flows

In the editor under *Import → Examples → @impact0815/node-red-contrib-viessmann*. After importing,
select your own connection in every Viessmann node.

| Example | Content |
|---|---|
| **01 first steps** | View the raw data of your own system; write in dry run (sends nothing) |
| **02 read → MQTT** | Read every 5 minutes and prepare as `viessmann/sensors`, `/boiler`, `/dhw`, `/circuit` – one extendable table instead of many function nodes |
| **03 circulation pump temporary** | Save current schedule, 20 minutes daytime schedule, then restore automatically; OFF and restore via button or link in |
| **04 hot water temporary** | The same for hot water preparation (`heating.dhw.schedule`) |

Examples 03 and 04 are protected against repeated triggering: pressing ON again within the
20 minutes extends the time but does not overwrite the backup of the real schedule.

---

## Reading

**See all values:** selection *All data points*, output *Raw API data* – shows exactly what your
system delivers. This is also the best material for bug reports.

**Pick specific values:** selection *Selected data points only* → *Load data points from device*.
✎ marks writable, ⚠ deprecated entries.

**Evaluate in a function node** (output *Object per data point*):

```javascript
const f = msg.payload["heating.sensors.temperature.outside"];
const outside = f ? f.values.value : null;   // null if the device does not deliver the value
```

**Forward to MQTT:** output *One message per data point*, topic prefix e.g. `heating`:

```
heating/heating.sensors.temperature.outside → 17.3
heating/heating.dhw.temperature.main        → 58
```

Properties of the incoming message (e.g. `msg.action`) are passed through. This makes
"read first, then decide" possible within one flow.

---

## Writing

Enable **Allow write access** in the configuration. Which commands your system offers is shown by
the write node after *Load writable data points* – including the allowed values. Try new commands
with **dry run** enabled first.

```javascript
// Hot water target temperature (limits come from the API, usually 10–60 °C)
msg.feature = "heating.dhw.temperature.main";
msg.command = "setTargetTemperature";
msg.payload = { temperature: 55 };

// Heat up hot water once, right now (if offered by the device)
msg.feature = "heating.dhw.oneTimeCharge";
msg.command = "activate";
msg.payload = {};

// Operating mode of heating circuit 0
msg.feature = "heating.circuits.0.operating.modes.active";
msg.command = "setMode";
msg.payload = { mode: "dhwAndHeating" };

// Heating curve
msg.feature = "heating.circuits.0.heating.curve";
msg.command = "setCurve";
msg.payload = { slope: 0.6, shift: 2 };

// Circulation pump permanently off (empty schedule)
msg.feature = "heating.dhw.pumps.circulation.schedule";
msg.command = "setSchedule";
msg.payload = { newSchedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };

// Holiday program
msg.feature = "heating.operating.programs.holiday";
msg.command = "schedule";
msg.payload = { start: "2026-12-20", end: "2027-01-03" };
```

| Safety mechanism | Effect |
|---|---|
| Off by default | Nothing is written without permission in the configuration |
| Allow list by the API | Only commands the device offers for this data point |
| Value ranges | Min, max, step size, allowed values and patterns are checked beforehand |
| Only on change | If the target value is already set, nothing happens (`skipped: true`) – also for schedules |
| Minimum interval | Configurable lock against write loops |
| Dry run | Check everything, send nothing |
| Separate outputs | Responses and errors never run in the data stream of measured values |

Schedules are always replaced completely (usually at most 4 entries per day, 10-minute grid). A
changed hot water schedule only starts heating if the cylinder is below the target temperature; for
immediate heating there is `heating.dhw.oneTimeCharge`.

---

## Not every device supports everything

The API returns the same large list for every system and marks with `isEnabled: false` what the
device does not support.

| State | Meaning |
|---|---|
| `available: true` | Device supports the data point **and** delivers values |
| `isEnabled: false` | Device does not have this function (e.g. solar without a solar system) |
| `empty: true` | Data point exists but currently has no content |

Deprecated data points name their successor, e.g. `heating.dhw.sensors.temperature.hotWaterStorage`
→ `heating.dhw.sensors.temperature.dhwCylinder` or `heating.boiler.serial` → `device.serial`. Your
own evaluations should try the new name first and then the old one – example 02 does exactly that.

---

## Polling interval and rate limit

The API has a daily limit, and the system only delivers new values every few minutes anyway.
Recommended: **300 seconds** interval and **30 seconds** cache. Several read nodes should share
**one** connection – the shared cache then fetches the data only once. When migrating from an old
flow, disable the old polling and token nodes, otherwise everything is queried twice.

---

## Symptom → cause → solution

| Symptom | Cause | Solution |
|---|---|---|
| "Invalid redirection URI" | Redirect URI differs from the portal | The message shows the address that was sent – compare it with the portal and copy it from there |
| "Viessmann requires an interactive login" | reCAPTCHA active in the portal, wrong credentials or redirect URI differs | Disable reCAPTCHA, check credentials and redirect URI |
| "Login rejected (HTTP 401)" | Username or password is incorrect | Check ViCare credentials |
| "Redeeming the authorization code failed" | Redirect URI or client ID differ | Compare both with the portal |
| "Invalid code challenge" | Too short or forbidden characters | Click *generate* or clear the field |
| "No installation found" | System not registered in ViCare, different account | Check the ViCare app |
| `HTTP 429` | Too many requests | Increase interval and cache, switch off old flows |
| Timeout | No internet from the container | `docker exec node-red ping -c1 api.viessmann-climatesolutions.com` |
| "Writing is disabled" | Permission missing | Enable *Allow write access* |
| Connection missing in imported flow | Examples deliberately contain no connection | Select your own connection in every Viessmann node |
| Node types registered twice | Old local installation still present | `npm uninstall node-red-contrib-viessmann`, restart Node-RED |
| Texts appear in the wrong language | Node-RED language setting | *User settings → View → Language*, then reload the browser |
| New fields missing in the editor | Browser cache | Ctrl+F5 |
| Written value not visible when reading | System needs one to two minutes | Wait a moment |

---

## Contributing

```bash
npm test      # tests against a simulated Viessmann server incl. identity provider and translations
npm run lint  # syntax, editor files, locales, package fields and example flows
```

The simulator in `test/mock-server.js` also covers the special cases: first start without token,
rejected refresh token, wrong password, active reCAPTCHA, different or encoded redirect URI, rotating
tokens, HTTP 401, rate limit and network errors. `test/i18n.test.js` makes sure English and German
always have the same keys and placeholders.

**Adding a language:** copy `nodes/locales/en-US/` to `nodes/locales/<code>/` (e.g. `fr`), translate
the three `.json` and three `.html` files and add the code to `LANGS` in `test/i18n.test.js` and
`tools/lint.js`.

Bug reports and wishes please as an
[issue](https://github.com/impact0815/node-red-contrib-viessmann/issues) – ideally with the raw data
of your own system (example 01) with serial numbers made unrecognizable.

---

## Sources

- [Rustimation.eu – Viessmann API und Node-Red](https://www.rustimation.eu/index.php/1_zugang_api/) – the basis for the API access
- [Viessmann API documentation](https://api.viessmann-climatesolutions.com/documentation)
- [Viessmann Developer Portal](https://app.developer.viessmann-climatesolutions.com)

## License

MIT – see [LICENSE](LICENSE). The license expressly excludes warranty and liability.
