(() => {
  const devicesEl = document.getElementById("devices");
  const emptyStateEl = document.getElementById("empty-state");
  const mqttStatusEl = document.getElementById("mqtt-status");
  const grafanaLinkEl = document.getElementById("grafana-link");

  let state = {};

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      const port = h.grafanaPort || "3000";
      grafanaLinkEl.href = `${location.protocol}//${location.hostname}:${port}`;
    })
    .catch(() => {});

  function setMqttStatus(connected) {
    if (connected === true) {
      mqttStatusEl.textContent = "MQTT: connected";
      mqttStatusEl.className = "pill pill-ok";
    } else if (connected === false) {
      mqttStatusEl.textContent = "MQTT: disconnected";
      mqttStatusEl.className = "pill pill-bad";
    } else {
      mqttStatusEl.textContent = "MQTT: connecting…";
      mqttStatusEl.className = "pill pill-unknown";
    }
  }

  function timeAgo(ts) {
    if (!ts) return "never";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function entityUnitAndValue(ent) {
    const raw = ent.state;
    if (raw === null || raw === undefined) return { display: "—", isOn: null };
    if (raw === "ON" || raw === "OFF" || raw === "online" || raw === "offline") {
      return { display: raw, isOn: raw === "ON" || raw === "online" };
    }
    return { display: raw, isOn: null };
  }

  function sendCommand(device, domain, object_id, payload, btnEl) {
    if (btnEl) btnEl.disabled = true;
    fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, domain, object_id, payload }),
    })
      .catch((e) => console.error("command failed", e))
      .finally(() => {
        if (btnEl) setTimeout(() => (btnEl.disabled = false), 400);
      });
  }

  function renderEntity(deviceKey, ent) {
    const wrap = document.createElement("div");
    wrap.className = "entity-card";

    const nameRow = document.createElement("div");
    nameRow.className = "entity-name";
    const nameSpan = document.createElement("span");
    nameSpan.textContent = ent.name;
    const badge = document.createElement("span");
    badge.className = "domain-badge";
    badge.textContent = ent.domain.replace("_", " ");
    nameRow.appendChild(nameSpan);
    nameRow.appendChild(badge);
    wrap.appendChild(nameRow);

    if (ent.controllable && ent.momentary) {
      const btn = document.createElement("button");
      btn.className = "action-btn";
      btn.textContent = ent.state === "ON" ? "Running…" : "Trigger";
      btn.onclick = () => {
        btn.classList.add("flash");
        setTimeout(() => btn.classList.remove("flash"), 600);
        sendCommand(deviceKey, ent.domain, ent.object_id, "ON", btn);
      };
      wrap.appendChild(btn);
      const timeEl = document.createElement("div");
      timeEl.className = "entity-time";
      timeEl.textContent = `updated ${timeAgo(ent.lastUpdate)}`;
      wrap.appendChild(timeEl);
    } else if (ent.controllable) {
      const row = document.createElement("div");
      row.className = "toggle-row";
      const label = document.createElement("span");
      const { isOn } = entityUnitAndValue(ent);
      label.textContent = isOn === null ? "unknown" : isOn ? "ON" : "OFF";
      label.className = `entity-value ${isOn ? "state-on" : "state-off"}`;
      const sw = document.createElement("label");
      sw.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!isOn;
      input.onchange = () => {
        sendCommand(deviceKey, ent.domain, ent.object_id, input.checked ? "ON" : "OFF", input);
      };
      const slider = document.createElement("span");
      slider.className = "slider";
      sw.appendChild(input);
      sw.appendChild(slider);
      row.appendChild(label);
      row.appendChild(sw);
      wrap.appendChild(row);
      const timeEl = document.createElement("div");
      timeEl.className = "entity-time";
      timeEl.textContent = `updated ${timeAgo(ent.lastUpdate)}`;
      wrap.appendChild(timeEl);
    } else {
      const { display } = entityUnitAndValue(ent);
      const valueEl = document.createElement("div");
      valueEl.className = "entity-value";
      valueEl.innerHTML = `${display}${ent.unit ? `<span class="unit">${ent.unit}</span>` : ""}`;
      wrap.appendChild(valueEl);
      const timeEl = document.createElement("div");
      timeEl.className = "entity-time";
      timeEl.textContent = `updated ${timeAgo(ent.lastUpdate)}`;
      wrap.appendChild(timeEl);
    }

    return wrap;
  }

  function render() {
    const deviceKeys = Object.keys(state).sort();
    emptyStateEl.hidden = deviceKeys.length > 0;
    devicesEl.innerHTML = "";
    for (const key of deviceKeys) {
      const dev = state[key];
      const card = document.createElement("section");
      card.className = "device-card";

      const header = document.createElement("div");
      header.className = "device-header";
      const left = document.createElement("div");
      const dot = document.createElement("span");
      dot.className = `status-dot ${dev.online === true ? "online" : dev.online === false ? "offline" : ""}`;
      const h2 = document.createElement("h2");
      h2.textContent = dev.displayName || dev.device;
      left.appendChild(dot);
      left.appendChild(h2);
      header.appendChild(left);
      const meta = document.createElement("span");
      meta.className = "device-meta";
      meta.textContent = `blueos/${dev.device} · last seen ${timeAgo(dev.lastSeen)}`;
      header.appendChild(meta);
      card.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "entities-grid";
      for (const ent of dev.entities) {
        grid.appendChild(renderEntity(dev.device, ent));
      }
      card.appendChild(grid);

      devicesEl.appendChild(card);
    }
  }

  function upsertEntity(deviceKey, domain, object_id, newState) {
    if (!state[deviceKey]) {
      state[deviceKey] = { device: deviceKey, displayName: deviceKey, online: true, lastSeen: Date.now(), entities: [] };
    }
    const dev = state[deviceKey];
    dev.online = true;
    dev.lastSeen = Date.now();
    let ent = dev.entities.find((e) => e.domain === domain && e.object_id === object_id);
    if (!ent) {
      ent = { domain, object_id, name: object_id, state: null, lastUpdate: null, controllable: false, momentary: false };
      dev.entities.push(ent);
    }
    ent.state = newState;
    ent.lastUpdate = Date.now();
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => setMqttStatus(null);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "full_state") {
        state = msg.state;
        setMqttStatus(msg.mqttConnected);
        render();
      } else if (msg.type === "entity_update") {
        upsertEntity(msg.device, msg.domain, msg.object_id, msg.state);
        render();
      } else if (msg.type === "device_status") {
        if (state[msg.device]) state[msg.device].online = msg.online;
        render();
      } else if (msg.type === "mqtt_status") {
        setMqttStatus(msg.connected);
      }
    };

    ws.onclose = () => {
      setMqttStatus(false);
      setTimeout(connectWs, 3000);
    };
    ws.onerror = () => ws.close();
  }

  function pollFallback() {
    fetch("/api/state")
      .then((r) => r.json())
      .then((s) => {
        state = s;
        render();
      })
      .catch(() => {});
  }

  fetch("/api/state")
    .then((r) => r.json())
    .then((s) => {
      state = s;
      render();
    })
    .catch(() => {});

  connectWs();
  setInterval(pollFallback, 15000);
})();
