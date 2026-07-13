(() => {
  const devicesEl = document.getElementById("devices");
  const emptyStateEl = document.getElementById("empty-state");
  const mqttStatusEl = document.getElementById("mqtt-status");
  const timeStatusEl = document.getElementById("time-status");
  const grafanaLinkEl = document.getElementById("grafana-link");
  const grafanaFrameEl = document.getElementById("grafana-frame");

  let state = {};
  let schedules = {};

  const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
  const DEFAULT_SCHEDULE = { enabled: false, on: "06:00", off: "18:00", days: "1111111" };

  fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      const port = h.grafanaPort || "3000";
      const grafanaBase = `${location.protocol}//${location.hostname}:${port}`;
      grafanaLinkEl.href = grafanaBase;
      grafanaFrameEl.src = `${grafanaBase}/d/blueos-esp-sensors?orgId=1&kiosk=tv&theme=dark&refresh=30s`;
      setTimeStatus(h.timeStatus);
    })
    .catch(() => {});

  fetch("/api/schedule")
    .then((r) => r.json())
    .then((s) => {
      schedules = s || {};
      render();
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

  function setTimeStatus(status) {
    if (!status || !status.time_source) {
      timeStatusEl.textContent = "Time: unknown";
      timeStatusEl.className = "pill pill-unknown";
      return;
    }
    const labels = {
      ntp: "Time: NTP",
      "esp-rtc": "Time: ESP RTC",
      "esp-rtc-ok": "Time: ESP RTC",
      "esp-rtc-correcting": "Time: syncing from RTC…",
      "esp-rtc-stale": "Time: RTC stale",
      unknown: "Time: unknown",
    };
    timeStatusEl.textContent = labels[status.time_source] || `Time: ${status.time_source}`;
    if (status.time_source === "ntp" || status.time_source === "esp-rtc" || status.time_source === "esp-rtc-ok") {
      timeStatusEl.className = "pill pill-ok";
    } else if (status.time_source === "esp-rtc-stale" || status.time_source === "unknown") {
      timeStatusEl.className = "pill pill-bad";
    } else {
      timeStatusEl.className = "pill pill-unknown";
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

  function sendSchedule(device, objectId, patch, formEl) {
    if (formEl) formEl.classList.add("saving");
    fetch("/api/schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, object_id: objectId, ...patch }),
    })
      .catch((e) => console.error("schedule save failed", e))
      .finally(() => {
        if (formEl) setTimeout(() => formEl.classList.remove("saving"), 400);
      });
  }

  function renderScheduleRow(deviceKey, ent) {
    const sc = (schedules[deviceKey] && schedules[deviceKey][ent.object_id]) || DEFAULT_SCHEDULE;
    const row = document.createElement("div");
    row.className = "schedule-row";

    const nameEl = document.createElement("div");
    nameEl.className = "schedule-name";
    nameEl.textContent = ent.name;
    row.appendChild(nameEl);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "switch schedule-enable";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!sc.enabled;
    enabledInput.title = "Schedule enabled";
    enabledInput.onchange = () => sendSchedule(deviceKey, ent.object_id, { enabled: enabledInput.checked }, row);
    const enabledSlider = document.createElement("span");
    enabledSlider.className = "slider";
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(enabledSlider);
    row.appendChild(enabledLabel);

    const onInput = document.createElement("input");
    onInput.type = "time";
    onInput.className = "schedule-time";
    onInput.value = sc.on;
    onInput.onchange = () => sendSchedule(deviceKey, ent.object_id, { on: onInput.value }, row);
    row.appendChild(onInput);

    const arrow = document.createElement("span");
    arrow.className = "schedule-arrow";
    arrow.textContent = "→";
    row.appendChild(arrow);

    const offInput = document.createElement("input");
    offInput.type = "time";
    offInput.className = "schedule-time";
    offInput.value = sc.off;
    offInput.onchange = () => sendSchedule(deviceKey, ent.object_id, { off: offInput.value }, row);
    row.appendChild(offInput);

    const daysWrap = document.createElement("div");
    daysWrap.className = "schedule-days";
    const dayChars = sc.days.split("");
    DAY_LABELS.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `day-btn ${dayChars[i] === "1" ? "active" : ""}`;
      btn.textContent = label;
      btn.onclick = () => {
        dayChars[i] = dayChars[i] === "1" ? "0" : "1";
        btn.classList.toggle("active");
        sendSchedule(deviceKey, ent.object_id, { days: dayChars.join("") }, row);
      };
      daysWrap.appendChild(btn);
    });
    row.appendChild(daysWrap);

    return row;
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

      const scheduledSwitches = dev.entities.filter((e) => e.domain === "switch" && /^relay_\d+$/.test(e.object_id));
      if (scheduledSwitches.length > 0) {
        const schedSection = document.createElement("div");
        schedSection.className = "schedule-section";
        const schedHeader = document.createElement("div");
        schedHeader.className = "schedule-section-header";
        schedHeader.textContent = "Schedule (daily on/off, edge-triggered — manual overrides between times are kept)";
        schedSection.appendChild(schedHeader);
        for (const ent of scheduledSwitches) {
          schedSection.appendChild(renderScheduleRow(dev.device, ent));
        }
        card.appendChild(schedSection);
      }

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
        if (msg.schedules) schedules = msg.schedules;
        setMqttStatus(msg.mqttConnected);
        if (msg.timeStatus) setTimeStatus(msg.timeStatus);
        render();
      } else if (msg.type === "entity_update") {
        upsertEntity(msg.device, msg.domain, msg.object_id, msg.state);
        render();
      } else if (msg.type === "device_status") {
        if (state[msg.device]) state[msg.device].online = msg.online;
        render();
      } else if (msg.type === "mqtt_status") {
        setMqttStatus(msg.connected);
      } else if (msg.type === "schedule_update") {
        schedules[msg.device] = schedules[msg.device] || {};
        schedules[msg.device][msg.object_id] = msg.schedule;
        render();
      } else if (msg.type === "time_status") {
        setTimeStatus(msg.status);
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
