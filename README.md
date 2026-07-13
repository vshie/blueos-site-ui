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
`PLAN.md` (workstation repo `BlueOS-HA-node`) milestone **M4**.

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
| WiFi Signal | sensor | `blueos/relay/sensor/wifi_signal/state` | read-only, dBm |
| Uptime | sensor | `blueos/relay/sensor/uptime/state` | read-only, s |
| Status (relay board) | binary_sensor | `blueos/relay/binary_sensor/status/state` | read-only |
| Boot Button | binary_sensor | `blueos/relay/binary_sensor/boot_button/state` | read-only |
| Firmware / IP / SSID / MAC | text_sensor | `blueos/relay/text_sensor/<name>/state` | read-only |
| Device availability | — | `blueos/relay/status` | `online` / `offline` |

## RTC / NTP time sync — what exists, what was added

The ESP has a DS3231 RTC (`ds1307` platform) and SNTP. On boot, and whenever
SNTP acquires time, ESPHome automatically writes wall time into the DS3231
(`on_time_sync: ds1307.write_time`). The YAML already had two **`button:`**
entities for manual read/write (`RTC Read from DS3231`, `RTC Write from ESP
time`) — but **ESPHome's MQTT integration has no `MQTTButtonComponent`**, so
native `button:` entities are only reachable over the native API or
`web_server`, never over MQTT.

**Fix applied in this task:** added a third option, a **momentary template
switch** (`rtc_sync_now`), because ESPHome's `switch:` domain *does* have MQTT
support. Turning it `ON` writes the current ESP time to the DS3231 and it
auto-resets to `OFF`. This is what the control page's "RTC Sync Now" card
calls.

- **File patched:** `../BlueOS-HA-node/esphome/blueos-relay.yaml` (in the
  workstation repo, not this one) — see the `rtc_sync_now` switch next to
  `buzzer_beep`.
- **Action required on the physical ESP:** this only takes effect after an
  OTA (or USB) reflash of `blueos-relay` — the currently-running firmware at
  `192.168.1.166` does **not** yet expose `blueos/relay/switch/rtc_sync_now/*`.
  Until reflashed, the control page will still show the "RTC Sync Now" card
  (from `devices.seed.json`) but the command will have no effect on the
  device (no error either — it's a fire-and-forget MQTT publish).
- OTA: `esphome upload blueos-relay.yaml` (or via `blueos-site-esphome` once
  that extension exists) using the `ota_password` secret already in the YAML.

## Install on BlueOS

Requires `blueos-site-stack` (Mosquitto + InfluxDB 1.8 + Telegraf) already
running so `:1883` and `:8086` are reachable on the host.

Open BlueOS → **Extensions** → **Installed** → **+** and fill:

| Field | Value |
|-------|--------|
| **Extension Identifier** | `vshie.siteui` |
| **Extension Name** | `Site UI (Grafana + Control)` |
| **Docker image** | `vshie/blueos-site-ui` |
| **Docker tag** | `main` |

**Custom settings** — paste verbatim:

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
        { "HostPort": "" }
      ],
      "3000/tcp": [
        { "HostPort": "3000" }
      ]
    },
    "Binds": [
      "/usr/blueos/extensions/site-ui:/var/lib/grafana"
    ]
  }
}
```

Then:

- **Control page** (primary HMI): the dynamic port assigned to `80/tcp`
  (Extensions → “Open”), or `http://<blueos-ip>:<port>/`.
- **Grafana**: `http://<blueos-ip>:3000` (fixed port, admin/admin by default,
  anonymous **Admin** viewing also enabled for LAN v0.1 — see “Auth” below).

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
