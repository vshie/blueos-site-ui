# blueos-site-ui — Grafana + MQTT Device Control (HA-style)

A BlueOS extension with two things in one container:

1. **Grafana** (provisioned) — trends/history only: WiFi RSSI, RTC temperature,
   relay state history, uptime, device online/offline.
2. **Control page** — a small Node.js + MQTT.js web app that is the
   **primary HMI**: it discovers devices/entities published under `blueos/#`
   and renders Home-Assistant-style cards (toggle switches, live sensor
   values, momentary actions) — no Grafana buttons, no HA install required.

```text
ESPHome node (blueos-relay)  --MQTT-->  Mosquitto (site-stack, :1883)
                                            |                 ^
                                            |                 |
                                  Telegraf ingests      control page
                                  (site-stack)           subscribes/publishes
                                            |                 |
                                            v                 v
                                    InfluxDB 1.8 (:8086)  browser (you)
                                            |
                                            v
                                  Grafana (this extension, :3000)
```

Grafana = graphs. This control page = switches + device actions. See
`PLAN.md` (workstation repo `BlueOS-HA-node`) milestone **M4**. The control
HTTP server exposes `/register_service` so **Site UI** appears in the BlueOS
sidebar
([docs](https://blueos.cloud/docs/latest/development/extensions/#web-interface-http-server)).

## What's inside

| Component | Detail |
|-----------|--------|
| Grafana | `grafana/grafana-oss:11.3.0`, provisioned InfluxQL datasource (`esphome` DB @ `host.docker.internal:8086`) + one starter dashboard |
| Control page | Node 20 + Express + [`mqtt.js`](https://github.com/mqttjs/MQTT.js) + `ws`, static HTML/CSS/JS front end, no build step |
| Base OS | Alpine 3.20 (from the official Grafana image) |

Both processes run in a single container (simplest BlueOS packaging — see
`entrypoint.sh`), matching the sibling `blueos-influxdb` extension's
multi-process pattern.

## MQTT convention (site-wide)

Entities follow the **ESPHome MQTT topic shape**, whether they come from a
real ESP node or another BlueOS extension emulating one:

```text
blueos/<device>/<domain>/<object_id>/state      (published by the device)
blueos/<device>/<domain>/<object_id>/command    (published by this control page)
blueos/<device>/status                          (birth/LWT: "online" / "offline")
```

- `<device>` — free-form path segment(s). ESPHome nodes use their
  `topic_prefix` minus the `blueos/` root, e.g. `relay` for `blueos-relay`
  (`topic_prefix: blueos/relay`).
- **Other BlueOS extensions** that want to appear as controllable entities on
  this page should publish under `blueos/ext/<name>/<domain>/<object_id>/...`
  (device key becomes `ext/<name>`) using the same `state`/`command` shape.
  No registration step is needed — the control page discovers any topic
  matching this pattern automatically. `devices.seed.json` lets you also
  pre-declare entities so they render before the first MQTT message arrives
  (used today for `blueos/relay`).
- `<domain>` — one of `switch`, `sensor`, `binary_sensor`, `text_sensor`,
  `light`, `number`, `select`, `cover`, `lock`, `climate`, `fan`, `button`,
  `siren`, `valve`, `update` (ESPHome's domain list). Only
  `switch/light/number/select/cover/lock/fan` are treated as **controllable**
  (a command topic is published on toggle); everything else is read-only.

### `blueos-relay` topic map (from `esphome/blueos-relay.yaml`)

| Entity | Domain | Topic (state) | Command payload |
|--------|--------|----------------|------------------|
| Relay 1‑6 | switch | `blueos/relay/switch/relay_N/state` | `ON` / `OFF` |
| Buzzer Beep | switch (momentary) | `blueos/relay/switch/buzzer_beep/state` | `ON` |
| **RTC Sync Now** | switch (momentary) | `blueos/relay/switch/rtc_sync_now/state` | `ON` |
| RTC Temperature | sensor | `blueos/relay/sensor/rtc_temperature/state` | read-only, °C |
| RTC Epoch | sensor | `blueos/relay/sensor/rtc_epoch/state` | read-only, unix seconds — used by `site-stack`'s time-from-RTC sidecar |
| WiFi Signal | sensor | `blueos/relay/sensor/wifi_signal/state` | read-only, dBm |
| Uptime | sensor | `blueos/relay/sensor/uptime/state` | read-only, s |
| Status (relay board) | binary_sensor | `blueos/relay/binary_sensor/status/state` | read-only |
| Boot Button | binary_sensor | `blueos/relay/binary_sensor/boot_button/state` | read-only |
| Firmware / IP / SSID / MAC / RTC datetime | **sensor** (ESPHome publishes `text_sensor` entities on the `sensor` MQTT domain, not `text_sensor`) | `blueos/relay/sensor/<name>/state` | read-only |
| Device availability | — | `blueos/relay/status` | `online` / `offline` |
| **Schedule set** (per relay) | — | `blueos/relay/schedule/relay_N/set` | JSON, retained — see below |
| **Schedule state** (per relay, echoed) | — | `blueos/relay/schedule/relay_N/state` | JSON, retained — see below |

## Relay scheduling — MQTT schema

Each relay (`relay_1`..`relay_6`) has an independent daily on/off schedule
evaluated on the ESP against its own RTC clock (not the host's), so it keeps
working even if the Pi/site-stack is down. Full design rationale lives in
`BlueOS-HA-node/esphome/schedule.h`; summary:

**Set a schedule** — publish retained JSON to `blueos/relay/schedule/relay_N/set`:

```json
{ "enabled": true, "on": "07:15", "off": "19:45", "days": "0111110" }
```

- `on`/`off` — `"HH:MM"` 24h local time (ESP's RTC-derived time). A window
  that wraps midnight (e.g. `on: "22:00", off: "06:00"`) is supported.
- `days` — 7-char string, index 0=Sunday .. 6=Saturday, `'1'`=active that day.
- The message is retained so the broker replays it to the ESP on every
  (re)connect/(re)subscribe — the schedule survives ESP reboots without any
  flash writes (avoids flash wear from frequent edits).
- Edge-triggered: the scheduler only *commands* the relay at the on/off
  transition, so a manual override (`blueos/relay/switch/relay_N/command`)
  made between edges is not immediately fought — it holds until the next
  scheduled transition.

**Read current schedule** — subscribe to `blueos/relay/schedule/relay_N/state`
(same JSON shape, retained, echoed by the ESP whenever it applies a new
schedule or reconnects).

The control page exposes this schema through:

- `GET /api/schedule` — all known relay schedules (from cached retained MQTT
  state), keyed by `device` → `object_id`.
- `POST /api/schedule` — body `{ "device": "relay", "object_id": "relay_1", "enabled": true, "on": "07:15", "off": "19:45", "days": "0111110" }` (any subset of `enabled`/`on`/`off`/`days`, merged onto the last known
  schedule); publishes the retained `.../set` message. The UI's per-relay
  "Schedule" editor (day-of-week buttons, on/off time pickers) calls this.
- WebSocket `schedule_update` push whenever a `.../state` topic changes, so
  all open browser tabs stay in sync.

## RTC / NTP time sync — what exists

The ESP has a DS3231 RTC (`ds1307` platform) and SNTP. On boot, and whenever
SNTP acquires time, ESPHome automatically writes wall time into the DS3231
(`on_time_sync: ds1307.write_time`), and the RTC is also periodically
re-read (`ds1307.update_interval: 6h`) to correct ESPHome's internal clock
from the chip if they drift. The YAML has two **`button:`** entities for
manual read/write (`RTC Read from DS3231`, `RTC Write from ESP time`) — but
**ESPHome's MQTT integration has no `MQTTButtonComponent`**, so native
`button:` entities are only reachable over the native API or `web_server`,
never over MQTT.

Instead, a **momentary template switch** (`rtc_sync_now`) is exposed over
MQTT — ESPHome's `switch:` domain *does* have MQTT support. Turning it `ON`
writes the current ESP time (from SNTP, if it has synced) to the DS3231 and
it auto-resets to `OFF`. This is what the control page's "RTC Sync Now" card
calls, and it's the "sync now when internet is available" button called for
in the product goal.

The Pi/host side of time sync (pulling `rtc_epoch` over MQTT to correct the
host clock when there's no internet) is implemented in `blueos-site-stack`'s
`time_from_rtc.py` sidecar — see that repo's README for details. This
control page surfaces its status as the **"Time: …" pill** in the top bar
(`ntp` / `esp-rtc` / `esp-rtc-stale` / `unknown`), sourced from
`blueos/ext/site-stack/json` via `GET /api/health` (`timeStatus` field) and
pushed live over the `time_status` WebSocket message.

## Embedded Grafana trends

The control page embeds the provisioned `blueos-esp-sensors` Grafana
dashboard directly below the device cards (kiosk mode, dark theme, 30s
auto-refresh) via an `<iframe>` pointed at
`http://<host>:<GRAFANA_PORT>/d/blueos-esp-sensors?orgId=1&kiosk=tv`.
`GF_SECURITY_ALLOW_EMBEDDING=true` is set in the Dockerfile so Grafana
allows being framed from the control page's different port/origin. This is
read-only history — all live control stays in the cards above it.

The dashboard has an **ESP board** variable (`topic_root`, e.g. `blueos/relay`)
auto-populated from Influx topic tags. Pick the board when you have more than
one. Relay history keeps stable `relay_N` series IDs; friendly names edited in
Site Controls are applied as Grafana display-name overrides (history stays
joined to the same channel).

## Adding another ESP board (auto pipeline)

1. **ESPHome Site** — copy/adapt a YAML (new `esphome.name`, unique
   `mqtt.topic_prefix` like `blueos/pump`), set sensors/relays, run the wizard
   for Wi‑Fi + broker secrets, then **flash / OTA**.
2. **MQTT** — board publishes `blueos/<device>/…/state` (+ `/status`).
3. **Site Controls** — discovers any device under `blueos/#` automatically
   (registry keyed by device path). No per-device registration.
4. **Telegraf → Influx** (`site-stack`) — already uses `+/sensor/…` and
   `+/switch/+/state` wildcards for the common blueos-relay metrics. New
   *metric names* beyond that list need a one-line Telegraf topic add.
5. **Grafana** — select the new board in the **ESP board** dropdown (manual
   once). Panels then graph that device’s history.

## Relay friendly labels

Site Controls lets you rename `relay_1`… on each card (✎). Labels persist via
retained MQTT `blueos/<device>/config/labels` and a file on the Grafana volume.
Firmware object IDs stay `relay_N`; only the display name changes — including
historical Grafana series display for that channel.

## Manual install on BlueOS (copy-paste)

**Prerequisite:** install **`blueos-site-stack`** first so MQTT `:1883` and
InfluxDB `:8086` are on the BlueOS host.

**Published image:** [`vshie/blueos-site-ui:main`](https://hub.docker.com/r/vshie/blueos-site-ui/tags)
(multi-arch: `linux/arm/v7`, `linux/arm64`, `linux/amd64`).

Open BlueOS → **Extensions** → **Installed** → **+** and fill exactly:

| Field | Value |
|-------|--------|
| **Extension Identifier** | `vshie.siteui` |
| **Extension Name** | `Site UI (Grafana + Control)` |
| **Docker image** | `vshie/blueos-site-ui` |
| **Docker tag** | `main` |

**Custom settings** (permissions JSON) — paste verbatim into the settings box:

```json
{
  "ExposedPorts": {
    "80/tcp": {},
    "3000/tcp": {}
  },
  "HostConfig": {
    "ExtraHosts": ["host.docker.internal:host-gateway"],
    "PortBindings": {
      "80/tcp": [
        {
          "HostPort": ""
        }
      ],
      "3000/tcp": [
        {
          "HostPort": "3000"
        }
      ]
    },
    "Binds": [
      "/usr/blueos/extensions/site-ui:/var/lib/grafana"
    ]
  }
}
```

After install:

| UI | URL |
|----|-----|
| **Control page** (primary HMI — relays, sensors, RTC sync) | Extensions → **Open** (dynamic host port for container `:80`) |
| **Grafana** (graphs only) | `http://<blueos-ip>:3000` |

Grafana default login: `admin` / `admin` (anonymous Admin also enabled for LAN
v0.1 — see Auth below). Control page has no auth on LAN.

## Ports

| Port | Binding | Use |
|------|---------|-----|
| `3000` | Host `3000` (fixed) | Grafana UI |
| `80` | Dynamic (BlueOS-assigned) | Control page (relays, sensors, RTC sync) |

## Auth (LAN v0.1)

- **Grafana**: default admin login is `admin` / `admin` (change on first
  login). `GF_AUTH_ANONYMOUS_ENABLED=true` also grants anonymous **Admin**
  viewers on the LAN — acceptable for a single-vehicle/site LAN v0.1 install,
  **not** for anything internet-exposed. Set `GF_AUTH_ANONYMOUS_ENABLED=false`
  as a container env override to require login.
- **Control page**: no auth (anyone on the LAN who can reach the dynamic port
  can toggle relays). This mirrors Home Assistant's default local network
  trust model; add a reverse-proxy/auth layer before exposing beyond LAN.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MQTT_HOST` | `host.docker.internal` | Broker host for the control page |
| `MQTT_PORT` | `1883` | Broker port |
| `MQTT_ROOT` | `blueos` | Topic root to subscribe/discover (`<root>/#`) |
| `CONTROL_PORT` | `80` | Control page HTTP+WS port (internal) |
| `GF_SERVER_HTTP_PORT` | `3000` | Grafana port (internal; keep in sync with the port binding) |
| `GRAFANA_PORT` | `3000` | Used only for the "Open Grafana" link in the control page UI |

## Building / releasing

| Platform | Hardware |
|----------|----------|
| `linux/arm/v7` | Pi 3B+, Pi 4 32-bit BlueOS |
| `linux/arm64/v8` | Pi 4 64-bit, **Pi 5** |
| `linux/amd64` | Desktop / CI |

Grafana's official `grafana-oss` images publish all three architectures, so
unlike some stacks, **no armv7 compromise was needed** here.

**CI secrets:** https://github.com/vshie/blueos-site-ui/settings/secrets/actions

- `DOCKER_USERNAME` = `vshie`
- `DOCKER_PASSWORD` = Docker Hub [access token](https://hub.docker.com/settings/security)

Image: **`vshie/blueos-site-ui:<tag>`**

Local build/test:

```bash
docker build -t blueos-site-ui:dev .
docker run --rm -p 3000:3000 -p 8080:80 \
  --add-host=host.docker.internal:host-gateway \
  -e MQTT_HOST=192.168.1.113 \
  blueos-site-ui:dev
# Grafana:      http://localhost:3000
# Control page: http://localhost:8080
```

## Provenance

| Layer | Source |
|-------|--------|
| Grafana | Official [`grafana/grafana-oss`](https://hub.docker.com/r/grafana/grafana-oss) |
| Node deps | `express`, `mqtt` (MQTT.js), `ws` — all MIT-licensed, installed via `npm ci` at build time |
| This repo | BlueOS wrapper + control-page app (not a fork of Grafana) |

## Roadmap / related repos

See workstation `BlueOS-HA-node/PLAN.md`. Operator-facing target:

1. `blueos-site-stack` — Mosquitto + InfluxDB 1.8 + Telegraf
2. **`blueos-site-ui`** (this repo) — Grafana + relay/device control page
3. `blueos-site-esphome` — Device Builder + bundled `blueos-relay` YAML,
   broker injected from BlueOS Beacon `GET /hostname`

## License

Packaging: community BlueOS extension conventions. Grafana: AGPLv3 (upstream
`grafana-oss`). Control page app: MIT (this repo).
