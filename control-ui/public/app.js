(() => {
  const devicesEl = document.getElementById("devices");
  const emptyStateEl = document.getElementById("empty-state");
  const mqttStatusEl = document.getElementById("mqtt-status");
  const timeStatusEl = document.getElementById("time-status");
  const grafanaLinkEl = document.getElementById("grafana-link");
  const grafanaFrameEl = document.getElementById("grafana-frame");
  const boardListEl = document.getElementById("esp-board-list");

  // BlueOS serves us under /extensionv2/<name>/ — absolute "/api/…" hits core and 404s.
  function extBase() {
    const path = location.pathname;
    const m = path.match(/^(.*?\/extensionv2\/[^/]+\/)/);
    if (m) return m[1];
    if (path.endsWith("/")) return path;
    if (/\.[a-zA-Z0-9]+$/.test(path.split("/").pop() || "")) {
      return path.replace(/\/[^/]*$/, "/");
    }
    return path + "/";
  }
  const BASE = extBase();
  function api(path) {
    return BASE + String(path).replace(/^\//, "");
  }

  let state = {};
  let schedules = {};
  let labels = {};

  // Poll/WS updates call render(), which wipes devicesEl and closes native <input type="time">
  // pickers (and mid-edit label fields). Defer destructive re-renders while the user is in
  // a schedule row or renaming a relay.
  let renderDeferred = false;
  let scheduleEditLock = false;
  let labelEditLock = false;
  let timePickerLock = false;
  let interactionGraceTimer = null;
  let timePickerGraceTimer = null;
  const INTERACTION_GRACE_MS = 400;
  // Native time pickers often blur the <input> while the OS/chrome picker is open.
  const TIME_PICKER_GRACE_MS = 1500;

  const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
  const DEFAULT_SCHEDULE = { enabled: false, on: "06:00", off: "18:00", days: "1111111" };
  const RELAY_RE = /^relay_\d+$/;

  function isScheduleControl(el) {
    return !!(el && el.closest && el.closest(".schedule-row, .schedule-section"));
  }

  function isLabelEditControl(el) {
    return !!(el && el.classList && el.classList.contains("name-edit-input"));
  }

  function isTimeInput(el) {
    return !!(el && el.matches && el.matches("input.schedule-time"));
  }

  function isInteractiveUiBusy() {
    if (scheduleEditLock || labelEditLock || timePickerLock) return true;
    const el = document.activeElement;
    return isScheduleControl(el) || isLabelEditControl(el);
  }

  function requestRender() {
    if (isInteractiveUiBusy()) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    render();
  }

  function flushDeferredRenderSoon(graceMs) {
    clearTimeout(interactionGraceTimer);
    interactionGraceTimer = setTimeout(() => {
      const el = document.activeElement;
      scheduleEditLock = isScheduleControl(el);
      labelEditLock = isLabelEditControl(el);
      if (scheduleEditLock || labelEditLock || timePickerLock) return;
      if (renderDeferred) {
        renderDeferred = false;
        render();
      }
    }, graceMs == null ? INTERACTION_GRACE_MS : graceMs);
  }

  devicesEl.addEventListener("focusin", (ev) => {
    const t = ev.target;
    if (isTimeInput(t)) {
      timePickerLock = true;
      scheduleEditLock = true;
      clearTimeout(timePickerGraceTimer);
      clearTimeout(interactionGraceTimer);
    } else if (isScheduleControl(t)) {
      scheduleEditLock = true;
      clearTimeout(interactionGraceTimer);
    }
    if (isLabelEditControl(t)) {
      labelEditLock = true;
      clearTimeout(interactionGraceTimer);
    }
  });

  devicesEl.addEventListener("focusout", (ev) => {
    if (isTimeInput(ev.target)) {
      // Keep lock while native picker may still be open after input blur.
      clearTimeout(timePickerGraceTimer);
      timePickerGraceTimer = setTimeout(() => {
        timePickerLock = false;
        flushDeferredRenderSoon(0);
      }, TIME_PICKER_GRACE_MS);
      return;
    }
    flushDeferredRenderSoon();
  });

  // Day toggles / enable switch: keep a short lock across clicks even if focus moves away.
  devicesEl.addEventListener("pointerdown", (ev) => {
    if (isScheduleControl(ev.target)) {
      scheduleEditLock = true;
      clearTimeout(interactionGraceTimer);
    }
  });

  devicesEl.addEventListener("pointerup", () => {
    flushDeferredRenderSoon();
  });

  // Selecting a time commits the value — release the picker lock promptly.
  devicesEl.addEventListener("change", (ev) => {
    if (isTimeInput(ev.target)) {
      clearTimeout(timePickerGraceTimer);
      timePickerLock = false;
      flushDeferredRenderSoon();
    }
  });

  fetch(api("api/health"))
    .then((r) => r.json())
    .then((h) => {
      const port = h.grafanaPort || "3000";
      const grafanaBase = `${location.protocol}//${location.hostname}:${port}`;
      grafanaLinkEl.href = grafanaBase;
      grafanaFrameEl.src = `${grafanaBase}/d/blueos-esp-sensors?orgId=1&kiosk=tv&theme=dark&refresh=30s`;
      setTimeStatus(h.timeStatus);
    })
    .catch(() => {});

  fetch(api("api/schedule"))
    .then((r) => r.json())
    .then((s) => {
      schedules = s || {};
      requestRender();
    })
    .catch(() => {});

  fetch(api("api/labels"))
    .then((r) => r.json())
    .then((l) => {
      labels = l || {};
      requestRender();
    })
    .catch(() => {});

  function setMqttStatus(connected) {
    if (connected === true) {
      mqttStatusEl.textContent = "Mailbox: connected";
      mqttStatusEl.className = "pill pill-ok";
    } else if (connected === false) {
      mqttStatusEl.textContent = "Mailbox: disconnected";
      mqttStatusEl.className = "pill pill-bad";
    } else {
      mqttStatusEl.textContent = "Mailbox: connecting…";
      mqttStatusEl.className = "pill pill-unknown";
    }
  }

  function setTimeStatus(status) {
    if (!status || !status.time_source) {
      timeStatusEl.textContent = "Clock: unknown";
      timeStatusEl.className = "pill pill-unknown";
      return;
    }
    const labelsMap = {
      ntp: "Clock: internet",
      "esp-rtc": "Clock: ESP board",
      "esp-rtc-ok": "Clock: ESP board",
      "esp-rtc-correcting": "Clock: syncing…",
      "esp-rtc-stale": "Clock: ESP stale",
      unknown: "Clock: unknown",
    };
    timeStatusEl.textContent = labelsMap[status.time_source] || `Clock: ${status.time_source}`;
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

  function relayLabel(deviceKey, objectId, fallbackName) {
    const fromMap = labels[deviceKey] && labels[deviceKey][objectId];
    if (fromMap) return fromMap;
    return fallbackName || objectId.replace(/^relay_/, "Relay ").replace(/_/g, " ");
  }

  function sendCommand(device, domain, object_id, payload, btnEl) {
    if (btnEl) btnEl.disabled = true;
    fetch(api("api/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, domain, object_id, payload }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("command failed");
        upsertEntity(device, domain, object_id, payload, Date.now());
        requestRender();
      })
      .catch((e) => console.error("command failed", e))
      .finally(() => {
        if (btnEl) setTimeout(() => (btnEl.disabled = false), 400);
      });
  }

  function saveLabel(device, objectId, label) {
    const trimmed = String(label || "").trim().slice(0, 64);
    if (!trimmed) return;
    labels[device] = labels[device] || {};
    labels[device][objectId] = trimmed;
    if (state[device]) {
      const ent = state[device].entities.find((e) => e.object_id === objectId);
      if (ent) ent.name = trimmed;
    }
    labelEditLock = false;
    renderDeferred = false;
    render();
    fetch(api("api/labels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, object_id: objectId, label: trimmed }),
    }).catch((e) => console.error("label save failed", e));
  }

  function findEntity(deviceKey, domain, objectId) {
    const dev = state[deviceKey];
    if (!dev) return null;
    return dev.entities.find((e) => e.domain === domain && e.object_id === objectId) || null;
  }

  function renderEditableName(deviceKey, ent) {
    const nameRow = document.createElement("div");
    nameRow.className = "entity-name";

    const nameWrap = document.createElement("span");
    nameWrap.className = "entity-name-edit";

    const nameSpan = document.createElement("span");
    nameSpan.className = "entity-name-text";
    nameSpan.textContent = RELAY_RE.test(ent.object_id)
      ? relayLabel(deviceKey, ent.object_id, ent.name)
      : ent.name;

    if (RELAY_RE.test(ent.object_id)) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "name-edit-btn";
      editBtn.title = "Rename this relay";
      editBtn.setAttribute("aria-label", "Rename relay");
      editBtn.textContent = "✎";
      editBtn.onclick = () => {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "name-edit-input";
        input.value = relayLabel(deviceKey, ent.object_id, ent.name);
        input.maxLength = 64;
        const commit = () => saveLabel(deviceKey, ent.object_id, input.value);
        input.onkeydown = (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            commit();
          } else if (ev.key === "Escape") {
            labelEditLock = false;
            renderDeferred = false;
            render();
          }
        };
        input.onblur = commit;
        nameWrap.replaceChild(input, nameSpan);
        editBtn.remove();
        input.focus();
        input.select();
      };
      nameWrap.appendChild(nameSpan);
      nameWrap.appendChild(editBtn);
    } else {
      nameWrap.appendChild(nameSpan);
    }

    const badge = document.createElement("span");
    badge.className = "domain-badge";
    if (ent.object_id === "rtc_sync_now") {
      badge.textContent = "action";
    } else {
      badge.textContent = ent.domain.replace("_", " ");
    }
    nameRow.appendChild(nameWrap);
    nameRow.appendChild(badge);
    return nameRow;
  }

  function renderRtcSyncCard(deviceKey, ent) {
    const wrap = document.createElement("div");
    wrap.className = "entity-card entity-card-action";
    wrap.appendChild(renderEditableName(deviceKey, ent));

    const help = document.createElement("div");
    help.className = "entity-help";
    help.textContent = "Copy internet time from this board onto its backup clock chip.";
    wrap.appendChild(help);

    const btn = document.createElement("button");
    btn.className = "action-btn";
    btn.textContent = "Sync clock now";
    btn.onclick = () => {
      btn.classList.add("flash");
      setTimeout(() => btn.classList.remove("flash"), 600);
      sendCommand(deviceKey, ent.domain, ent.object_id, "ON", btn);
    };
    wrap.appendChild(btn);

    const lastSyncEnt =
      findEntity(deviceKey, "sensor", "rtc_last_sync") ||
      findEntity(deviceKey, "text_sensor", "rtc_last_sync");
    const timeEl = document.createElement("div");
    timeEl.className = "entity-time";
    if (lastSyncEnt && lastSyncEnt.state && lastSyncEnt.state !== "never" && lastSyncEnt.state !== "unknown") {
      timeEl.textContent = `Last synced: ${lastSyncEnt.state}`;
    } else if (ent.lastUpdate) {
      timeEl.textContent = `Last synced: ${timeAgo(ent.lastUpdate)}`;
    } else {
      timeEl.textContent = "Last synced: never";
    }
    wrap.appendChild(timeEl);
    return wrap;
  }

  function renderEntity(deviceKey, ent) {
    if (ent.object_id === "rtc_sync_now") {
      return renderRtcSyncCard(deviceKey, ent);
    }
    // Hide the raw last-sync sensor card; it is shown on the sync action card.
    if (ent.object_id === "rtc_last_sync") {
      return document.createDocumentFragment();
    }

    const wrap = document.createElement("div");
    wrap.className = "entity-card";
    wrap.appendChild(renderEditableName(deviceKey, ent));

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
    // Optimistic update — schedule.enabled must stick even before MQTT echo.
    schedules[device] = schedules[device] || {};
    const prev = schedules[device][objectId] || { ...DEFAULT_SCHEDULE };
    schedules[device][objectId] = {
      ...prev,
      ...patch,
      device,
      object_id: objectId,
      lastUpdate: Date.now(),
    };
    if (formEl) formEl.classList.add("saving");
    // Prefer requestRender so an open time picker / mid-click day toggle is not destroyed.
    // Local controls already reflect the optimistic patch.
    requestRender();
    fetch(api("api/schedule"), {
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
    nameEl.textContent = relayLabel(deviceKey, ent.object_id, ent.name);
    row.appendChild(nameEl);

    const enabledWrap = document.createElement("div");
    enabledWrap.className = "schedule-enable-wrap";
    const enabledLabel = document.createElement("label");
    enabledLabel.className = "switch schedule-enable";
    enabledLabel.title = "Use daily schedule (board clock)";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = !!sc.enabled;
    enabledInput.setAttribute("aria-label", "Use daily schedule");
    enabledInput.onchange = () => sendSchedule(deviceKey, ent.object_id, { enabled: enabledInput.checked }, row);
    const enabledSlider = document.createElement("span");
    enabledSlider.className = "slider";
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(enabledSlider);
    const enabledText = document.createElement("span");
    enabledText.className = "schedule-enable-text";
    enabledText.textContent = sc.enabled ? "Auto on during window" : "Use daily schedule";
    enabledWrap.appendChild(enabledLabel);
    enabledWrap.appendChild(enabledText);
    row.appendChild(enabledWrap);

    const onInput = document.createElement("input");
    onInput.type = "time";
    onInput.className = "schedule-time";
    onInput.value = sc.on;
    onInput.title = "Turn on at";
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
    offInput.title = "Turn off at";
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

  function renderBoardList() {
    if (!boardListEl) return;
    const deviceKeys = Object.keys(state).sort();
    boardListEl.innerHTML = "";
    if (deviceKeys.length === 0) {
      const li = document.createElement("li");
      li.className = "board-list-empty";
      li.textContent = "None yet — flash a board in ESPHome Site; it appears here when it connects.";
      boardListEl.appendChild(li);
      return;
    }
    for (const key of deviceKeys) {
      const dev = state[key];
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#device-${CSS.escape ? CSS.escape(key) : key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      link.className = "board-list-link";
      const dot = document.createElement("span");
      dot.className = `status-dot ${dev.online === true ? "online" : dev.online === false ? "offline" : ""}`;
      const name = document.createElement("span");
      name.textContent = dev.displayName || dev.device;
      const meta = document.createElement("span");
      meta.className = "board-list-meta";
      meta.textContent =
        dev.online === true ? "online" : dev.online === false ? "offline" : "seen";
      link.appendChild(dot);
      link.appendChild(name);
      link.appendChild(meta);
      li.appendChild(link);
      boardListEl.appendChild(li);
    }
  }

  function render() {
    const deviceKeys = Object.keys(state).sort();
    emptyStateEl.hidden = deviceKeys.length > 0;
    devicesEl.innerHTML = "";
    renderBoardList();

    for (const key of deviceKeys) {
      const dev = state[key];
      const card = document.createElement("section");
      card.className = "device-card";
      card.id = `device-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

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
        const node = renderEntity(dev.device, ent);
        if (node) grid.appendChild(node);
      }
      card.appendChild(grid);

      const scheduledSwitches = dev.entities.filter(
        (e) => e.domain === "switch" && RELAY_RE.test(e.object_id)
      );
      if (scheduledSwitches.length > 0) {
        const schedSection = document.createElement("div");
        schedSection.className = "schedule-section";
        const schedHeader = document.createElement("div");
        schedHeader.className = "schedule-section-header";
        schedHeader.textContent =
          "Daily on-window (board clock) — this switch enables the schedule, it does not power the relay right now";
        schedSection.appendChild(schedHeader);
        for (const ent of scheduledSwitches) {
          schedSection.appendChild(renderScheduleRow(dev.device, ent));
        }
        card.appendChild(schedSection);
      }

      devicesEl.appendChild(card);
    }
  }

  function upsertEntity(deviceKey, domain, object_id, newState, lastUpdate) {
    if (!state[deviceKey]) {
      state[deviceKey] = {
        device: deviceKey,
        displayName: deviceKey,
        online: true,
        lastSeen: Date.now(),
        entities: [],
      };
    }
    const dev = state[deviceKey];
    if (dev.online === null || dev.online === undefined) dev.online = true;
    dev.lastSeen = Date.now();
    let ent = dev.entities.find((e) => e.domain === domain && e.object_id === object_id);
    if (!ent) {
      ent = {
        domain,
        object_id,
        name: RELAY_RE.test(object_id)
          ? relayLabel(deviceKey, object_id, object_id)
          : object_id,
        state: null,
        lastUpdate: null,
        controllable: ["switch", "light", "number", "select", "cover", "lock", "fan"].includes(domain),
        momentary: /sync|beep|buzzer|restart|reset|press/i.test(object_id),
      };
      dev.entities.push(ent);
    }
    if (newState !== undefined) ent.state = newState;
    if (lastUpdate !== undefined) ent.lastUpdate = lastUpdate;
    else ent.lastUpdate = Date.now();
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${BASE}ws`);

    ws.onopen = () => setMqttStatus(null);

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "full_state") {
        state = msg.state || {};
        if (msg.schedules) schedules = msg.schedules;
        if (msg.labels) labels = msg.labels;
        setMqttStatus(msg.mqttConnected);
        if (msg.timeStatus) setTimeStatus(msg.timeStatus);
        requestRender();
      } else if (msg.type === "entity_update") {
        upsertEntity(msg.device, msg.domain, msg.object_id, msg.state, msg.lastUpdate);
        requestRender();
      } else if (msg.type === "device_status") {
        if (!state[msg.device]) {
          state[msg.device] = {
            device: msg.device,
            displayName: msg.device,
            online: msg.online,
            lastSeen: Date.now(),
            entities: [],
          };
        } else {
          state[msg.device].online = msg.online;
          state[msg.device].lastSeen = Date.now();
        }
        requestRender();
      } else if (msg.type === "mqtt_status") {
        setMqttStatus(msg.connected);
      } else if (msg.type === "schedule_update") {
        schedules[msg.device] = schedules[msg.device] || {};
        schedules[msg.device][msg.object_id] = msg.schedule;
        requestRender();
      } else if (msg.type === "labels_update") {
        labels[msg.device] = msg.labels || {};
        requestRender();
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

  // REST poll keeps the UI usable when WebSocket fails through the BlueOS proxy.
  function pollFallback() {
    fetch(api("api/state"))
      .then((r) => r.json())
      .then((s) => {
        state = s;
        requestRender();
      })
      .catch(() => {});
    fetch(api("api/schedule"))
      .then((r) => r.json())
      .then((s) => {
        // Merge, don't wipe optimistic local edits with a stale empty body.
        const incoming = s || {};
        for (const [device, map] of Object.entries(incoming)) {
          schedules[device] = schedules[device] || {};
          for (const [objectId, sc] of Object.entries(map || {})) {
            schedules[device][objectId] = sc;
          }
        }
        requestRender();
      })
      .catch(() => {});
    fetch(api("api/labels"))
      .then((r) => r.json())
      .then((l) => {
        labels = l || labels;
        requestRender();
      })
      .catch(() => {});
    fetch(api("api/health"))
      .then((r) => r.json())
      .then((h) => {
        if (typeof h.mqttConnected === "boolean") setMqttStatus(h.mqttConnected);
        if (h.timeStatus) setTimeStatus(h.timeStatus);
      })
      .catch(() => {});
  }

  fetch(api("api/state"))
    .then((r) => r.json())
    .then((s) => {
      state = s;
      requestRender();
    })
    .catch(() => {});

  connectWs();
  pollFallback();
  setInterval(pollFallback, 4000);
})();
