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

// ---- Registry: device -> { displayName, online, lastSeen, entities: { key -> entity } }
const registry = new Map();

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
      dev.entities.set(entKey, {
        domain: ent.domain,
        object_id: ent.object_id,
        name: ent.name || ent.object_id,
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
  if (!ent) {
    ent = {
      domain,
      object_id: objectId,
      name: humanize(objectId),
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
seedRegistry();

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
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mqttConnected, mqttUrl, mqttRoot: MQTT_ROOT, grafanaPort: GRAFANA_PORT });
});

app.get("/api/state", (req, res) => {
  res.json(serializeRegistry());
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
    res.json({ ok: true, topic: commandTopic, payload: String(payload) });
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "full_state", state: serializeRegistry(), mqttConnected }));
});

server.listen(CONTROL_PORT, "0.0.0.0", () => {
  console.log(`[http] blueos-site-ui control page listening on :${CONTROL_PORT}`);
});
