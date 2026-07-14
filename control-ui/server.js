"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const mqtt = require("mqtt");
const { WebSocketServer } = require("ws");

const MQTT_HOST = process.env.MQTT_HOST || "host.docker.internal";
const MQTT_PORT = process.env.MQTT_PORT || "1883";
const MQTT_ROOT = (process.env.MQTT_ROOT || "blueos").replace(/\/$/, "");
const CONTROL_PORT = process.env.CONTROL_PORT || process.env.PORT || "80";
const GRAFANA_PORT = process.env.GRAFANA_PORT || "3000";
const LABELS_FILE =
  process.env.LABELS_FILE || "/var/lib/grafana/blueos-relay-labels.json";
const DASHBOARD_FILE =
  process.env.DASHBOARD_FILE || "/etc/grafana/dashboards/esp-sensors.json";

// Domains whose state topics can be commanded (ESPHome MQTT convention:
// <root>/<device>/<domain>/<object_id>/state  <->  .../command).
const CONTROLLABLE_DOMAINS = new Set([
  "switch",
  "light",
  "number",
  "select",
  "cover",
  "lock",
  "fan",
]);

// Matches "<root>/<device...>/<domain>/<object_id>/state" — device may itself
// contain slashes, e.g. "ext/mydevice", per the blueos/ext/<name>/... convention.
const DOMAIN_ALTERNATION = [
  "switch",
  "sensor",
  "binary_sensor",
  "text_sensor",
  "light",
  "number",
  "select",
  "cover",
  "lock",
  "climate",
  "fan",
  "button",
  "siren",
  "valve",
  "update",
].join("|");
const STATE_TOPIC_RE = new RegExp(
  `^${escapeRegExp(MQTT_ROOT)}\\/(.+)\\/(${DOMAIN_ALTERNATION})\\/([^/]+)\\/state$`
);
const AVAILABILITY_TOPIC_RE = new RegExp(`^${escapeRegExp(MQTT_ROOT)}\\/(.+)\\/status$`);
// Relay schedule config channel. Durable store is the retained .../set topic;
// .../state is an optional ESP echo. Site Controls accepts both.
const SCHEDULE_TOPIC_RE = new RegExp(
  `^${escapeRegExp(MQTT_ROOT)}\\/(.+)\\/schedule\\/([^/]+)\\/(state|set)$`
);
const LABELS_TOPIC_RE = new RegExp(
  `^${escapeRegExp(MQTT_ROOT)}\\/(.+)\\/config\\/labels$`
);
// Time-from-RTC sidecar status (blueos-site-stack), see its README.
const TIME_STATUS_TOPIC = `${MQTT_ROOT}/ext/site-stack/json`;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAYS_RE = /^[01]{7}$/;
const RELAY_OBJECT_RE = /^relay_\d+$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guessUnit(objectId, name) {
  const s = `${objectId} ${name}`.toLowerCase();
  if (s.includes("temp")) return "\u00b0C";
  if (s.includes("signal") || s.includes("rssi")) return "dBm";
  if (s.includes("uptime")) return "s";
  if (s.includes("humidity")) return "%";
  if (s.includes("voltage")) return "V";
  if (s.includes("current")) return "A";
  return "";
}

function isMomentary(objectId, name) {
  return /sync|beep|buzzer|restart|reset|press/i.test(`${objectId} ${name}`);
}

function defaultRelayLabel(objectId) {
  const m = String(objectId).match(/^relay_(\d+)$/);
  return m ? `Relay ${m[1]}` : humanize(objectId);
}

// ---- Registry: device -> { displayName, online, lastSeen, entities: { key -> entity } }
const registry = new Map();

// ---- Schedule registry: "device/object_id" -> {enabled, on, off, days, lastUpdate}
const scheduleRegistry = new Map();
// ---- Labels: device -> { object_id -> friendly label }
const labelRegistry = new Map();
let timeStatus = null; // latest parsed payload from blueos/ext/site-stack/json
let timeStatusUpdated = null;

function applyScheduleMessage(deviceKey, objectId, payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const key = `${deviceKey}/${objectId}`;
  const prev = scheduleRegistry.get(key) || {
    device: deviceKey,
    object_id: objectId,
    enabled: false,
    on: "06:00",
    off: "18:00",
    days: "1111111",
  };
  const next = {
    device: deviceKey,
    object_id: objectId,
    enabled: parsed.enabled !== undefined ? !!parsed.enabled : !!prev.enabled,
    on:
      typeof parsed.on === "string" && HHMM_RE.test(parsed.on)
        ? parsed.on
        : prev.on,
    off:
      typeof parsed.off === "string" && HHMM_RE.test(parsed.off)
        ? parsed.off
        : prev.off,
    days:
      typeof parsed.days === "string" && DAYS_RE.test(parsed.days)
        ? parsed.days
        : prev.days,
    lastUpdate: Date.now(),
  };
  scheduleRegistry.set(key, next);
}

function serializeSchedules() {
  const out = {};
  for (const [, sc] of scheduleRegistry.entries()) {
    out[sc.device] = out[sc.device] || {};
    out[sc.device][sc.object_id] = sc;
  }
  return out;
}

function labelsTopic(deviceKey) {
  return `${MQTT_ROOT}/${deviceKey}/config/labels`;
}

function loadLabelsFromDisk() {
  try {
    if (!fs.existsSync(LABELS_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(LABELS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    for (const [deviceKey, map] of Object.entries(parsed)) {
      if (!map || typeof map !== "object") continue;
      const cleaned = {};
      for (const [objectId, label] of Object.entries(map)) {
        if (typeof label === "string" && label.trim()) {
          cleaned[objectId] = label.trim().slice(0, 64);
        }
      }
      labelRegistry.set(deviceKey, cleaned);
      applyLabelsToDevice(deviceKey);
    }
    console.log(`[labels] loaded ${LABELS_FILE}`);
  } catch (err) {
    console.error("[labels] failed to load file:", err.message);
  }
}

function saveLabelsToDisk() {
  try {
    const dir = path.dirname(LABELS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const out = serializeLabels();
    fs.writeFileSync(LABELS_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("[labels] failed to save file:", err.message);
  }
}

function serializeLabels() {
  const out = {};
  for (const [deviceKey, map] of labelRegistry.entries()) {
    out[deviceKey] = { ...map };
  }
  return out;
}

function applyLabelsToDevice(deviceKey) {
  const dev = registry.get(deviceKey);
  if (!dev) return;
  const map = labelRegistry.get(deviceKey) || {};
  for (const ent of dev.entities.values()) {
    if (!RELAY_OBJECT_RE.test(ent.object_id)) continue;
    ent.name = map[ent.object_id] || defaultRelayLabel(ent.object_id);
  }
}

function normalizeLabels(labels) {
  const cleaned = {};
  for (const [objectId, label] of Object.entries(labels || {})) {
    if (!RELAY_OBJECT_RE.test(objectId)) continue;
    if (typeof label !== "string") continue;
    const trimmed = label.trim().slice(0, 64);
    if (trimmed) cleaned[objectId] = trimmed;
  }
  return cleaned;
}

function labelsEqual(a, b) {
  const ak = Object.keys(a || {}).sort();
  const bk = Object.keys(b || {}).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function applyLabelMap(deviceKey, labels, { persist = true, patchDashboard = true } = {}) {
  const cleaned = normalizeLabels(labels);
  const prev = labelRegistry.get(deviceKey) || {};
  if (labelsEqual(prev, cleaned)) {
    applyLabelsToDevice(deviceKey);
    return cleaned;
  }
  labelRegistry.set(deviceKey, cleaned);
  applyLabelsToDevice(deviceKey);
  if (persist) saveLabelsToDisk();
  if (patchDashboard) patchGrafanaRelayAliases();
  return cleaned;
}

function setDeviceLabels(deviceKey, labels) {
  return applyLabelMap(deviceKey, labels, { persist: true, patchDashboard: true });
}

function patchGrafanaRelayAliases() {
  try {
    if (!fs.existsSync(DASHBOARD_FILE)) return;
    const dash = JSON.parse(fs.readFileSync(DASHBOARD_FILE, "utf8"));
    const panel = (dash.panels || []).find((p) => p.id === 3);
    if (!panel) return;
    const overrides = [];
    let index = 0;
    for (const [deviceKey, map] of labelRegistry.entries()) {
      for (const [objectId, label] of Object.entries(map)) {
        const topic = `${MQTT_ROOT}/${deviceKey}/switch/${objectId}/state`;
        overrides.push({
          matcher: { id: "byName", options: topic },
          properties: [{ id: "displayName", value: label }],
        });
        // Also match alias forms Grafana may produce from $tag_topic.
        overrides.push({
          matcher: { id: "byRegexp", options: escapeRegExp(topic) },
          properties: [{ id: "displayName", value: label }],
        });
        index += 1;
      }
    }
    panel.fieldConfig = panel.fieldConfig || { defaults: {}, overrides: [] };
    // Keep non-label overrides (value mappings live in defaults).
    const kept = (panel.fieldConfig.overrides || []).filter((o) => {
      const props = (o && o.properties) || [];
      return !props.some((p) => p && p.id === "displayName");
    });
    panel.fieldConfig.overrides = kept.concat(overrides);
    dash.version = (dash.version || 1) + 1;
    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dash, null, 2));
    console.log(`[labels] patched ${overrides.length} Grafana displayName overrides`);
  } catch (err) {
    console.error("[labels] dashboard patch failed:", err.message);
  }
}

function getOrCreateDevice(deviceKey) {
  if (!registry.has(deviceKey)) {
    registry.set(deviceKey, {
      device: deviceKey,
      displayName: deviceKey,
      online: null,
      lastSeen: null,
      entities: new Map(),
    });
  }
  return registry.get(deviceKey);
}

function seedRegistry() {
  const seedPath = path.join(__dirname, "devices.seed.json");
  if (!fs.existsSync(seedPath)) return;
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  for (const [deviceKey, def] of Object.entries(seed)) {
    const dev = getOrCreateDevice(deviceKey);
    dev.displayName = def.displayName || deviceKey;
    for (const ent of def.entities || []) {
      const entKey = `${ent.domain}/${ent.object_id}`;
      const stateTopic = `${MQTT_ROOT}/${deviceKey}/${ent.domain}/${ent.object_id}/state`;
      const labelMap = labelRegistry.get(deviceKey) || {};
      const seededName = ent.name || ent.object_id;
      const name = RELAY_OBJECT_RE.test(ent.object_id)
        ? labelMap[ent.object_id] || seededName || defaultRelayLabel(ent.object_id)
        : seededName;
      dev.entities.set(entKey, {
        domain: ent.domain,
        object_id: ent.object_id,
        name,
        unit: ent.unit || guessUnit(ent.object_id, ent.name || ""),
        momentary: !!ent.momentary || isMomentary(ent.object_id, ent.name || ""),
        icon: ent.icon || "",
        state: null,
        lastUpdate: null,
        seeded: true,
        controllable: CONTROLLABLE_DOMAINS.has(ent.domain),
        stateTopic,
        commandTopic: CONTROLLABLE_DOMAINS.has(ent.domain)
          ? `${MQTT_ROOT}/${deviceKey}/${ent.domain}/${ent.object_id}/command`
          : null,
      });
    }
  }
}

function humanize(objectId) {
  return objectId
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function applyStateMessage(deviceKey, domain, objectId, payload) {
  const dev = getOrCreateDevice(deviceKey);
  dev.lastSeen = Date.now();
  if (dev.online === null) dev.online = true;
  const entKey = `${domain}/${objectId}`;
  let ent = dev.entities.get(entKey);
  const labelMap = labelRegistry.get(deviceKey) || {};
  if (!ent) {
    ent = {
      domain,
      object_id: objectId,
      name: RELAY_OBJECT_RE.test(objectId)
        ? labelMap[objectId] || defaultRelayLabel(objectId)
        : humanize(objectId),
      unit: guessUnit(objectId, objectId),
      momentary: isMomentary(objectId, objectId),
      icon: "",
      state: null,
      lastUpdate: null,
      seeded: false,
      controllable: CONTROLLABLE_DOMAINS.has(domain),
      stateTopic: `${MQTT_ROOT}/${deviceKey}/${domain}/${objectId}/state`,
      commandTopic: CONTROLLABLE_DOMAINS.has(domain)
        ? `${MQTT_ROOT}/${deviceKey}/${domain}/${objectId}/command`
        : null,
    };
    dev.entities.set(entKey, ent);
  } else if (RELAY_OBJECT_RE.test(objectId)) {
    ent.name = labelMap[objectId] || ent.name || defaultRelayLabel(objectId);
  }
  ent.state = payload;
  ent.lastUpdate = Date.now();
}

function applyAvailability(deviceKey, payload) {
  const dev = getOrCreateDevice(deviceKey);
  dev.online = payload === "online";
  dev.lastSeen = Date.now();
}

function serializeRegistry() {
  const out = {};
  for (const [deviceKey, dev] of registry.entries()) {
    out[deviceKey] = {
      device: dev.device,
      displayName: dev.displayName,
      online: dev.online,
      lastSeen: dev.lastSeen,
      entities: Array.from(dev.entities.values()).sort((a, b) =>
        `${a.domain}/${a.object_id}`.localeCompare(`${b.domain}/${b.object_id}`)
      ),
    };
  }
  return out;
}

// ---- MQTT ----
loadLabelsFromDisk();
seedRegistry();
applyLabelsToDevice("relay");
patchGrafanaRelayAliases();

const mqttUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
let mqttConnected = false;
const client = mqtt.connect(mqttUrl, {
  clientId: `blueos-site-ui-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

client.on("connect", () => {
  mqttConnected = true;
  console.log(`[mqtt] connected to ${mqttUrl}, subscribing ${MQTT_ROOT}/#`);
  client.subscribe(`${MQTT_ROOT}/#`, { qos: 0 });
  // Re-publish retained labels so Telegraf/Grafana consumers (if any) stay warm.
  for (const [deviceKey, map] of labelRegistry.entries()) {
    client.publish(labelsTopic(deviceKey), JSON.stringify(map), { qos: 0, retain: true });
  }
  broadcast({ type: "mqtt_status", connected: true });
});

client.on("reconnect", () => {
  console.log("[mqtt] reconnecting...");
});

client.on("close", () => {
  mqttConnected = false;
  broadcast({ type: "mqtt_status", connected: false });
});

client.on("error", (err) => {
  console.error("[mqtt] error:", err.message);
});

client.on("message", (topic, payloadBuf) => {
  const payload = payloadBuf.toString();

  if (topic === TIME_STATUS_TOPIC) {
    try {
      timeStatus = JSON.parse(payload);
      timeStatusUpdated = Date.now();
      broadcast({ type: "time_status", status: timeStatus, updated: timeStatusUpdated });
    } catch {
      // ignore malformed status payloads
    }
    return;
  }

  const labelsMatch = topic.match(LABELS_TOPIC_RE);
  if (labelsMatch) {
    const [, deviceKey] = labelsMatch;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") {
        const cleaned = applyLabelMap(deviceKey, parsed, { persist: true, patchDashboard: true });
        broadcast({ type: "labels_update", device: deviceKey, labels: cleaned });
        broadcast({
          type: "full_state",
          state: serializeRegistry(),
          schedules: serializeSchedules(),
          labels: serializeLabels(),
          timeStatus,
          mqttConnected,
        });
      }
    } catch {
      // ignore malformed label payloads
    }
    return;
  }

  const scheduleMatch = topic.match(SCHEDULE_TOPIC_RE);
  if (scheduleMatch) {
    const [, deviceKey, objectId] = scheduleMatch;
    applyScheduleMessage(deviceKey, objectId, payload);
    broadcast({
      type: "schedule_update",
      device: deviceKey,
      object_id: objectId,
      schedule: scheduleRegistry.get(`${deviceKey}/${objectId}`),
    });
    return;
  }

  const stateMatch = topic.match(STATE_TOPIC_RE);
  if (stateMatch) {
    const [, deviceKey, domain, objectId] = stateMatch;
    applyStateMessage(deviceKey, domain, objectId, payload);
    broadcast({
      type: "entity_update",
      device: deviceKey,
      domain,
      object_id: objectId,
      state: payload,
    });
    return;
  }
  const availMatch = topic.match(AVAILABILITY_TOPIC_RE);
  if (availMatch) {
    const [, deviceKey] = availMatch;
    applyAvailability(deviceKey, payload);
    broadcast({ type: "device_status", device: deviceKey, online: payload === "online" });
  }
});

// ---- HTTP + WebSocket ----
const app = express();
app.use(express.json());

// BlueOS sidebar registration — must be served by the extension HTTP server:
// https://blueos.cloud/docs/latest/development/extensions/#web-interface-http-server
app.get("/register_service", (req, res) => {
  res.json({
    name: "Site Controls",
    description:
      "Turn relays on/off, set daily schedules, and watch trends from your ESP boards.",
    icon: "mdi-toggle-switch",
    company: "Community",
    version: "0.4.0",
    webpage: "https://github.com/vshie/blueos-site-ui",
    api: "https://github.com/vshie/blueos-site-ui/blob/main/README.md",
    new_page: false,
    works_in_relative_paths: true,
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    mqttConnected,
    mqttUrl,
    mqttRoot: MQTT_ROOT,
    grafanaPort: GRAFANA_PORT,
    timeStatus,
    timeStatusUpdated,
  });
});

app.get("/api/state", (req, res) => {
  res.json(serializeRegistry());
});

app.get("/api/schedule", (req, res) => {
  res.json(serializeSchedules());
});

app.get("/api/labels", (req, res) => {
  res.json(serializeLabels());
});

app.post("/api/labels", (req, res) => {
  const { device, object_id, label, labels } = req.body || {};
  if (!device) {
    return res.status(400).json({ error: "device is required" });
  }
  const current = { ...(labelRegistry.get(device) || {}) };
  if (labels && typeof labels === "object") {
    Object.assign(current, labels);
  }
  if (object_id) {
    if (!RELAY_OBJECT_RE.test(object_id)) {
      return res.status(400).json({ error: "object_id must look like relay_N" });
    }
    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ error: "label must be a non-empty string" });
    }
    current[object_id] = label.trim().slice(0, 64);
  }
  if (Object.keys(current).length === 0 && !labels && !object_id) {
    return res.status(400).json({ error: "provide labels map or object_id+label" });
  }
  const cleaned = setDeviceLabels(device, current);
  if (!mqttConnected) {
    return res.status(503).json({ error: "MQTT broker not connected", labels: cleaned });
  }
  client.publish(labelsTopic(device), JSON.stringify(cleaned), { qos: 0, retain: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    broadcast({ type: "labels_update", device, labels: cleaned });
    broadcast({
      type: "full_state",
      state: serializeRegistry(),
      schedules: serializeSchedules(),
      labels: serializeLabels(),
      timeStatus,
      mqttConnected,
    });
    res.json({ ok: true, device, labels: cleaned, topic: labelsTopic(device) });
  });
});

app.post("/api/schedule", (req, res) => {
  const { device, object_id, enabled, on, off, days } = req.body || {};
  if (!device || !object_id) {
    return res.status(400).json({ error: "device and object_id are required" });
  }
  const key = `${device}/${object_id}`;
  const prev = scheduleRegistry.get(key) || {
    device,
    object_id,
    enabled: false,
    on: "06:00",
    off: "18:00",
    days: "1111111",
  };
  const merged = {
    device,
    object_id,
    enabled: enabled !== undefined ? !!enabled : !!prev.enabled,
    on: on !== undefined ? on : prev.on,
    off: off !== undefined ? off : prev.off,
    days: days !== undefined ? days : prev.days,
    lastUpdate: Date.now(),
  };
  if (!HHMM_RE.test(merged.on)) {
    return res.status(400).json({ error: `'on' must be HH:MM, got '${merged.on}'` });
  }
  if (!HHMM_RE.test(merged.off)) {
    return res.status(400).json({ error: `'off' must be HH:MM, got '${merged.off}'` });
  }
  if (!DAYS_RE.test(merged.days)) {
    return res.status(400).json({ error: "'days' must be a 7-char string of 0/1" });
  }
  if (
    enabled === undefined &&
    on === undefined &&
    off === undefined &&
    days === undefined
  ) {
    return res.status(400).json({ error: "at least one of enabled/on/off/days is required" });
  }

  const payload = {
    enabled: merged.enabled,
    on: merged.on,
    off: merged.off,
    days: merged.days,
  };
  const setTopic = `${MQTT_ROOT}/${device}/schedule/${object_id}/set`;
  if (!mqttConnected) {
    return res.status(503).json({ error: "MQTT broker not connected" });
  }

  // Authoritative for the UI immediately (retained /set is the durable store;
  // ESP may echo .../state later, but must not be required for the toggle to stick).
  scheduleRegistry.set(key, merged);
  broadcast({ type: "schedule_update", device, object_id, schedule: merged });

  client.publish(setTopic, JSON.stringify(payload), { qos: 0, retain: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, topic: setTopic, payload });
  });
});

app.post("/api/command", (req, res) => {
  const { device, domain, object_id, payload } = req.body || {};
  if (!device || !domain || !object_id || payload === undefined) {
    return res.status(400).json({ error: "device, domain, object_id, payload are required" });
  }
  if (!CONTROLLABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ error: `domain '${domain}' is not controllable` });
  }
  const commandTopic = `${MQTT_ROOT}/${device}/${domain}/${object_id}/command`;
  if (!mqttConnected) {
    return res.status(503).json({ error: "MQTT broker not connected" });
  }
  client.publish(commandTopic, String(payload), { qos: 0 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    // Momentary actions often never leave a lasting state topic; stamp lastUpdate
    // so the UI can show "just now" after a successful publish.
    const dev = getOrCreateDevice(device);
    const ent = dev.entities.get(`${domain}/${object_id}`);
    if (ent) {
      ent.lastUpdate = Date.now();
      if (ent.momentary) ent.state = String(payload);
    }
    broadcast({
      type: "entity_update",
      device,
      domain,
      object_id,
      state: ent ? ent.state : String(payload),
      lastUpdate: ent ? ent.lastUpdate : Date.now(),
      commanded: true,
    });
    res.json({ ok: true, topic: commandTopic, payload: String(payload) });
  });
});

const server = http.createServer(app);
// Accept /ws and any path BlueOS may leave after stripping /extensionv2/... —
// the proxy sometimes rewrites or drops the path on upgrade.
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "full_state",
      state: serializeRegistry(),
      schedules: serializeSchedules(),
      labels: serializeLabels(),
      timeStatus,
      mqttConnected,
    })
  );
});

server.listen(CONTROL_PORT, "0.0.0.0", () => {
  console.log(`[http] blueos-site-ui control page listening on :${CONTROL_PORT}`);
});
