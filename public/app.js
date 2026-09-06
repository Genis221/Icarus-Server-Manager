const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = ["30 mins", "1 hr", "2 hrs", "4 hrs", "6 hrs", "12 hrs", "24 hrs"];

const state = {
  servers: [],
  activity: [],
  activeId: null,
  pollTimer: null,
  saveTimers: new Map(),
  pendingPatches: new Map(),
  openSections: new Set(),
  busy: new Set(),
  repairPrompted: new Set(),
  consoleSource: null,
  consoleServerId: null
};

const workspace = document.getElementById("workspace");
const tabsEl = document.getElementById("tabs");
const toastStack = document.getElementById("toast-stack");
const infoDialog = document.getElementById("info-dialog");
const copyDialog = document.getElementById("copy-dialog");
const confirmDialog = document.getElementById("confirm-dialog");
const firewallDialog = document.getElementById("firewall-dialog");
const repairDialog = document.getElementById("repair-dialog");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<p>${escapeHtml(message)}</p>`;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function activeServer() {
  return state.servers.find(s => s.id === state.activeId) || state.servers[0] || null;
}

function schedulePatch(id, patch) {
  const server = state.servers.find(s => s.id === id);
  if (!server) return;
  Object.assign(server, patch);
  if (patch.profile !== undefined) renderTabs();
  const pending = { ...(state.pendingPatches.get(id) || {}), ...patch };
  state.pendingPatches.set(id, pending);
  if (state.saveTimers.has(id)) clearTimeout(state.saveTimers.get(id));
  state.saveTimers.set(id, setTimeout(async () => {
    const body = state.pendingPatches.get(id) || {};
    state.pendingPatches.delete(id);
    try {
      const updated = await api(`/api/servers/${id}`, { method: "PATCH", body });
      const idx = state.servers.findIndex(s => s.id === id);
      if (idx >= 0) state.servers[idx] = { ...state.servers[idx], ...updated };
    } catch (err) {
      toast(err.message, "error");
    }
  }, 500));
}

function statusClass(server) {
  const status = String(server.status || "").toLowerCase();
  const availability = String(server.availability || "").toLowerCase();
  if (status === "updating" || availability.includes("start")) return "starting";
  if (status === "running") return "running";
  return "stopped";
}

function statusDisplay(server) {
  const status = String(server?.status || "").toLowerCase();
  const availability = String(server?.availability || "").toLowerCase();
  if (status === "updating") return { label: "Updating", tone: "warn" };
  if (availability.includes("start") || status.includes("start")) {
    return { label: "Starting…", tone: "warn" };
  }
  if (status === "running") return { label: "Running", tone: "good" };
  return { label: "Offline", tone: "bad" };
}

function availabilityClass(value) {
  const v = String(value || "").toLowerCase();
  if (v === "online") return "good";
  if (v.includes("start") || v === "unreachable") return "warn";
  return "bad";
}

function firewallClass(value) {
  const v = String(value || "").toLowerCase();
  if (v === "good") return "good";
  if (v.includes("admin") || v.includes("no port")) return "bad";
  return "warn";
}

function renderTabs() {
  const servers = [...state.servers].sort((a, b) => a.order - b.order);
  if (!state.activeId && servers[0]) state.activeId = servers[0].id;
  tabsEl.innerHTML = servers.map(server => `
    <button type="button" class="tab ${statusClass(server)} ${server.id === state.activeId ? "active" : ""}"
      data-id="${server.id}" draggable="true" role="tab" aria-selected="${server.id === state.activeId}">
      <span>${escapeHtml(server.profile || "New Server")}</span>
      <span class="close" data-close="${server.id}" title="Close">×</span>
    </button>
  `).join("");
}

function dayChecks(name, values) {
  return DAYS.map((day, i) => `
    <label><input type="checkbox" data-field="${name}" data-index="${i}" ${values?.[i] ? "checked" : ""} /> ${day}</label>
  `).join("");
}

function disconnectConsole() {
  if (state.consoleSource) {
    state.consoleSource.close();
    state.consoleSource = null;
  }
  state.consoleServerId = null;
}

function connectConsole(serverId) {
  if (state.consoleServerId === serverId && state.consoleSource) return;
  disconnectConsole();
  state.consoleServerId = serverId;
  const source = new EventSource(`/api/servers/${serverId}/console-stream`);
  state.consoleSource = source;
  source.onmessage = event => {
    try {
      const entry = JSON.parse(event.data);
      appendConsoleLine(entry);
      const el = document.getElementById("console-output");
      if (el) el.scrollTop = el.scrollHeight;
    } catch { /* ignore */ }
  };
  source.onerror = () => {
    const status = document.getElementById("console-live-status");
    if (status) {
      status.dataset.state = "reconnecting";
      const label = status.querySelector("b");
      if (label) label.textContent = "Reconnecting";
    }
  };
  source.onopen = () => {
    const status = document.getElementById("console-live-status");
    if (status) {
      status.dataset.state = "live";
      const label = status.querySelector("b");
      if (label) label.textContent = "Live";
    }
  };
}

function appendConsoleLine(entry) {
  const el = document.getElementById("console-output");
  if (!el) return;
  const empty = el.querySelector(".console-empty");
  if (empty) empty.remove();
  const line = document.createElement("div");
  line.className = `console-line ${entry.level || "info"}`;
  const time = new Date(entry.time || Date.now()).toLocaleTimeString();
  line.innerHTML = `<time>${escapeHtml(time)}</time><span>${escapeHtml(entry.message || "")}</span>`;
  el.appendChild(line);
  while (el.children.length > 600) el.removeChild(el.firstChild);
}

function rconHint(server) {
  const rcon = server.rcon || {};
  if (!rcon.hasPassword) return "Set AdminPassword in ServerSettings.ini, then use in-game /AdminLogin";
  return "Admin commands are in-game: /AdminLogin, /AdminSay, /KickPlayer, /ReturnToLobby";
}

function renderServer(server) {
  if (!server) {
    workspace.innerHTML = `<div class="empty-view"><p>No server profiles yet.</p></div>`;
    return;
  }
  const running = String(server.status).toLowerCase() === "running";
  const updating = String(server.status).toLowerCase() === "updating";
  const busy = state.busy.has(server.id) || updating;
  const open = key => state.openSections.has(`${server.id}:${key}`) ? "open" : "";
  const statusUi = statusDisplay(server);

  workspace.innerHTML = `
    <div class="server-page" data-server-id="${server.id}">
      <div class="server-main">
        <section class="header-card">
          <div class="header-top">
            <label class="field">
              <span>Profile</span>
              <input data-field="profile" value="${escapeHtml(server.profile)}" maxlength="80" />
            </label>
            <div class="controls-row">
              <button type="button" class="btn ${running ? "stop" : "start"}" data-action="toggle" ${busy ? "disabled" : ""}>
                ${running ? "Stop" : "Start"}
              </button>
              <button type="button" class="btn primary" data-action="update" ${busy ? "disabled" : ""}>Update / Verify</button>
            </div>
          </div>

          <div class="grid-2">
            <label class="field">
              <span>Installed Version</span>
              <input data-field="version" value="${escapeHtml(server.version || "")}" readonly />
            </label>
            <div class="field">
              <span class="field-label">Install Location</span>
              <div class="path-row">
                <input class="inline-input" data-field="install" value="${escapeHtml(server.install || "")}" placeholder="C:\\path\\to\\Icarus Dedicated Server" />
                <button type="button" class="btn secondary" data-action="validate-install">Set Location</button>
              </div>
            </div>
          </div>

          <div class="field">
            <span class="field-label">SteamCMD</span>
            <div class="path-row">
              <input class="inline-input" data-field="steamcmd" value="${escapeHtml(server.steamcmd || "")}" placeholder="C:\\Users\\...\\Documents\\SteamCMD" />
              <button type="button" class="btn secondary" data-action="validate-steamcmd">Browse</button>
              <button type="button" class="btn primary" data-action="download-steamcmd">Download SteamCMD</button>
            </div>
          </div>

          <label class="field">
            <span>Launch Arguments</span>
            <input data-field="launchArgs" value="${escapeHtml(server.launchArgs || "")}" placeholder="TheIsland_WP?listen?Port=7777?QueryPort=27015 ..." />
          </label>

          <div class="stats">
            <article class="stat-card ${statusUi.tone}">
              <span>Status</span>
              <strong>${escapeHtml(statusUi.label)}</strong>
            </article>
            <article class="stat-card ${availabilityClass(server.availability)}">
              <span>Availability</span>
              <strong>${escapeHtml(server.availability || "Offline")}</strong>
            </article>
            <article class="stat-card ${Number(server.players) > 0 ? "good" : ""}">
              <span>Players</span>
              <strong>${Number(server.players) || 0} / ${Number(server.maxPlayers) || 70}</strong>
            </article>
            <article class="stat-card ${firewallClass(server.firewallStatus)}">
              <span>Firewall</span>
              <strong>${escapeHtml(server.firewallStatus || "Not Checked")}</strong>
            </article>
          </div>
        </section>

        <div class="configs-heading">
          <h2>Server Configs</h2>
          <p>Schedules, backups, INI files, and log paths</p>
        </div>

        <div class="scroll-sections">
          <section class="section ${open("autostart")}" data-section="autostart">
            <button type="button" class="section-toggle"><span class="chev">▶</span> Automatic Start</button>
            <div class="section-body">
              <div class="day-row">${dayChecks("autostartDays", server.autostartDays)}</div>
              <label class="field"><span>Start Server at</span><input type="time" data-field="autostartTime" value="${escapeHtml(toTimeInput(server.autostartTime))}" /></label>
              <label class="check-line"><input type="checkbox" data-field="autostartUpdate" ${server.autostartUpdate ? "checked" : ""} /> Perform update (Prior to Server Starting)</label>
            </div>
          </section>

          <section class="section ${open("shutdown")}" data-section="shutdown">
            <button type="button" class="section-toggle"><span class="chev">▶</span> Automatic Shutdown / Restart</button>
            <div class="section-body">
              <div class="day-row">${dayChecks("shutdownDays", server.shutdownDays)}</div>
              <label class="field"><span>Shutdown at</span><input type="time" data-field="shutdownTime" value="${escapeHtml(toTimeInput(server.shutdownTime))}" /></label>
              <label class="check-line"><input type="checkbox" data-field="performUpdate" ${server.performUpdate ? "checked" : ""} /> Perform update</label>
              <label class="check-line"><input type="checkbox" data-field="thenRestart" ${server.thenRestart ? "checked" : ""} /> Then restart</label>
            </div>
          </section>

          <section class="section ${open("config")}" data-section="config">
            <button type="button" class="section-toggle"><span class="chev">▶</span> Server Configuration</button>
            <div class="section-body">
            <div class="action-row">
              <button type="button" class="btn secondary" data-action="open-gus-ini">Edit ServerSettings.ini</button>
            </div>
            </div>
          </section>

          <section class="section ${open("backup")}" data-section="backup">
            <button type="button" class="section-toggle"><span class="chev">▶</span> Automatic World Save Backup</button>
            <div class="section-body">
              <label class="field">
                <span>Interval</span>
                <select data-field="autoBackupInterval">
                  ${INTERVALS.map(v => `<option value="${v}" ${server.autoBackupInterval === v ? "selected" : ""}>${v}</option>`).join("")}
                </select>
              </label>
              <label class="field">
                <span>Keep last N backups</span>
                <input type="number" min="10" max="100" data-field="backupLimit" value="${escapeHtml(server.backupLimit || "10")}" />
              </label>
              <div class="field">
                <span class="field-label">Backup Folder</span>
                <div class="path-row">
                  <input class="inline-input" data-field="autoBackupDest" value="${escapeHtml(server.autoBackupDest || "")}" />
                  <button type="button" class="btn secondary" data-action="validate-backup">Browse</button>
                </div>
              </div>
              <div class="action-row">
                <button type="button" class="btn primary" data-action="backup" ${server.backupInProgress ? "disabled" : ""}>Backup Now</button>
                <label class="check-line"><input type="checkbox" data-field="autoBackupEnabled" ${server.autoBackupEnabled ? "checked" : ""} /> Enable Auto Backup</label>
              </div>
            </div>
          </section>

          <section class="section ${open("logs")}" data-section="logs">
            <button type="button" class="section-toggle"><span class="chev">▶</span> Logs</button>
            <div class="section-body">
              <div class="field">
                <span class="field-label">Game Log Location</span>
                <div class="path-row">
                  <input class="inline-input" data-field="logLocation" value="${escapeHtml(server.logLocation || "")}" />
                  <button type="button" class="btn secondary" data-action="validate-logs">Browse</button>
                </div>
              </div>
              <div class="field">
                <span class="field-label">Update Log Location</span>
                <div class="path-row">
                  <input class="inline-input" data-field="updateLogLocation" value="${escapeHtml(server.updateLogLocation || "")}" />
                  <button type="button" class="btn secondary" data-action="validate-update-logs">Browse</button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <aside class="server-console">
        <section class="console-panel">
          <div class="console-toolbar">
            <strong class="console-title">Console</strong>
            <div class="console-live-status" id="console-live-status" data-state="live"><i></i><b>Live</b></div>
            <span class="console-hint">${escapeHtml(rconHint(server))}</span>
            <div class="console-tools">
              <button type="button" class="btn secondary" data-action="console-clear">Clear</button>
              <button type="button" class="btn secondary" data-action="console-players">ListPlayers</button>
              <button type="button" class="btn secondary" data-action="console-getchat">GetChat</button>
            </div>
          </div>
          <div class="console-output" id="console-output"><div class="console-empty">Live Icarus log output will appear here…</div></div>
          <form class="console-command" id="console-form">
            <label class="chat-toggle" title="Send as ServerChat"><input type="checkbox" id="console-as-chat" /> Chat</label>
            <input id="console-input" type="text" autocomplete="off" spellcheck="false" placeholder="Notes appear in the live log" />
            <button type="submit" class="btn primary">Send</button>
          </form>
        </section>
      </aside>
    </div>
  `;

  connectConsole(server.id);
}

function toTimeInput(value) {
  const text = String(value || "09:00");
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "09:00";
  return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
}

function fromTimeInput(value) {
  return String(value || "09:00").slice(0, 5);
}

function render() {
  renderTabs();
  renderServer(activeServer());
}

async function refreshState({ silent = false } = {}) {
  try {
    const data = await api("/api/state");
    const prevFocus = document.activeElement;
    const focusKey = prevFocus?.dataset?.field
      ? `${prevFocus.closest("[data-server-id]")?.dataset.serverId}:${prevFocus.dataset.field}:${prevFocus.dataset.index ?? ""}`
      : null;
    const selectionStart = prevFocus?.selectionStart;
    const selectionEnd = prevFocus?.selectionEnd;

    state.servers = data.servers || [];
    state.activity = data.activity || [];
    window.__icarusHost = data.host || null;
    if (!state.servers.find(s => s.id === state.activeId)) {
      state.activeId = state.servers[0]?.id || null;
    }

    // Keep the live console mounted — only refresh chrome/stats on poll
    const page = workspace.querySelector(`[data-server-id="${state.activeId}"]`);
    const consoleMounted = Boolean(page && document.getElementById("console-output"));
    if (consoleMounted || (focusKey && prevFocus && ["INPUT", "SELECT", "TEXTAREA"].includes(prevFocus.tagName))) {
      renderTabs();
      updateLiveStats(activeServer());
      const hint = document.querySelector(".console-hint");
      if (hint && activeServer()) hint.textContent = rconHint(activeServer());
      if (state.activeId) connectConsole(state.activeId);
    } else {
      render();
    }

    if (focusKey) {
      const [id, field, index] = focusKey.split(":");
      const el = workspace.querySelector(
        index !== ""
          ? `[data-server-id="${id}"] [data-field="${field}"][data-index="${index}"]`
          : `[data-server-id="${id}"] [data-field="${field}"]`
      );
      if (el) {
        el.focus();
        if (typeof selectionStart === "number" && el.setSelectionRange) {
          try { el.setSelectionRange(selectionStart, selectionEnd); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    if (!silent) {
      workspace.innerHTML = `<div class="empty-view"><p>Could not reach manager API.<br>${escapeHtml(err.message)}</p></div>`;
    }
  }
}

function setStatTone(card, tone) {
  if (!card) return;
  card.classList.remove("good", "warn", "bad");
  if (tone) card.classList.add(tone);
}

function updateLiveStats(server) {
  if (!server) return;
  const page = workspace.querySelector(`[data-server-id="${server.id}"]`);
  if (!page) return;
  const cards = [...page.querySelectorAll(".stats .stat-card")];
  const updating = String(server.status).toLowerCase() === "updating";
  const busy = state.busy.has(server.id) || updating;
  const running = String(server.status).toLowerCase() === "running";
  const playerCount = Number(server.players) || 0;
  const statusUi = statusDisplay(server);

  if (cards[0]) {
    const strong = cards[0].querySelector("strong");
    if (strong) strong.textContent = statusUi.label;
    setStatTone(cards[0], statusUi.tone);
  }
  if (cards[1]) {
    const strong = cards[1].querySelector("strong");
    if (strong) strong.textContent = server.availability || "Offline";
    setStatTone(cards[1], availabilityClass(server.availability));
  }
  if (cards[2]) {
    const strong = cards[2].querySelector("strong");
    if (strong) strong.textContent = `${playerCount} / ${Number(server.maxPlayers) || 70}`;
    setStatTone(cards[2], playerCount > 0 ? "good" : "");
  }
  if (cards[3]) {
    const strong = cards[3].querySelector("strong");
    if (strong) strong.textContent = server.firewallStatus || "Not Checked";
    setStatTone(cards[3], firewallClass(server.firewallStatus));
  }

  const toggle = page.querySelector("[data-action='toggle']");
  if (toggle) {
    toggle.textContent = running ? "Stop" : "Start";
    toggle.classList.toggle("stop", running);
    toggle.classList.toggle("start", !running);
    toggle.disabled = busy;
  }
  const updateBtn = page.querySelector("[data-action='update']");
  if (updateBtn) updateBtn.disabled = busy;
  renderTabs();
  maybePromptRepair(server);
}

async function askRepairConsent(server) {
  return new Promise(resolve => {
    const message = document.getElementById("repair-message");
    if (message) {
      message.textContent =
        `SteamCMD reported app state 0x6 for "${server.profile}". This usually means a stuck or corrupt install. Repair will delete everything under the install folder except Icarus\\Saved (worlds and configs), then redownload the server.`;
    }
    repairDialog.showModal();
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      repairDialog.close();
      document.getElementById("repair-ok").removeEventListener("click", onOk);
      document.getElementById("repair-cancel").removeEventListener("click", onCancel);
    }
    document.getElementById("repair-ok").addEventListener("click", onOk);
    document.getElementById("repair-cancel").addEventListener("click", onCancel);
  });
}

async function maybePromptRepair(server) {
  if (!server) return;
  if (!server.needsRepair || server.updating) {
    if (!server.needsRepair) state.repairPrompted.delete(server.id);
    return;
  }
  if (state.repairPrompted.has(server.id) || repairDialog?.open) return;
  state.repairPrompted.add(server.id);
  const ok = await askRepairConsent(server);
  if (!ok) return;
  state.repairPrompted.delete(server.id);
  toast("Repair & redownload started — watch the Console", "success");
  connectConsole(server.id);
  await api(`/api/servers/${server.id}/update`, { method: "POST", body: { repair: true } });
  await refreshState({ silent: true });
}

async function confirmDelete(server) {
  return new Promise(resolve => {
    document.getElementById("confirm-title").textContent = "Delete Server Profile";
    document.getElementById("confirm-message").textContent =
      `Delete profile "${server.profile}"? This does not delete server files on disk.`;
    confirmDialog.showModal();
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    function cleanup() {
      confirmDialog.close();
      document.getElementById("confirm-ok").removeEventListener("click", onOk);
      document.getElementById("confirm-cancel").removeEventListener("click", onCancel);
    }
    document.getElementById("confirm-ok").addEventListener("click", onOk);
    document.getElementById("confirm-cancel").addEventListener("click", onCancel);
  });
}

async function askFirewallConsent(server) {
  return new Promise(resolve => {
    const message = document.getElementById("firewall-message");
    if (message) {
      message.textContent =
        `Allow Icarus Manager to add Windows firewall rules for "${server.profile}" (game UDP/TCP and query ports) when this server starts? Choose "Allow & start" once and you will not be asked again for this profile. "Start without firewall" or "Cancel start" will ask again next time.`;
    }
    firewallDialog.showModal();
    const onAllow = () => { cleanup(); resolve("allow"); };
    const onSkip = () => { cleanup(); resolve("skip"); };
    const onCancel = () => { cleanup(); resolve("cancel"); };
    function cleanup() {
      firewallDialog.close();
      document.getElementById("firewall-allow").removeEventListener("click", onAllow);
      document.getElementById("firewall-skip").removeEventListener("click", onSkip);
      document.getElementById("firewall-cancel").removeEventListener("click", onCancel);
    }
    document.getElementById("firewall-allow").addEventListener("click", onAllow);
    document.getElementById("firewall-skip").addEventListener("click", onSkip);
    document.getElementById("firewall-cancel").addEventListener("click", onCancel);
  });
}

async function startServerWithFirewallPrompt(server) {
  let applyFirewall = Boolean(server.firewallAutoApproved);
  if (!applyFirewall) {
    const choice = await askFirewallConsent(server);
    if (choice === "cancel") return false;
    applyFirewall = choice === "allow";
    // skip / allow both leave approved only when allow — skip asks again next start
  }
  await withBusy(server.id, async () => {
    await api(`/api/servers/${server.id}/start`, {
      method: "POST",
      body: { applyFirewall }
    });
  });
  if (applyFirewall) {
    server.firewallAutoApproved = true;
    toast("Approve the Windows admin prompt if it appears — firewall rules will auto-apply after that", "success");
  }
  return true;
}

async function withBusy(id, fn) {
  state.busy.add(id);
  render();
  try {
    return await fn();
  } finally {
    state.busy.delete(id);
    await refreshState({ silent: true });
  }
}

async function validatePath(field, label) {
  const server = activeServer();
  if (!server) return;
  const value = String(server[field] || "").trim();
  if (!value) {
    toast(`Enter a ${label} path first`, "error");
    return;
  }
  try {
    const result = await api("/api/path/validate", { method: "POST", body: { path: value } });
    if (result.exists) toast(`${label} path is valid`, "success");
    else toast(`${label} path was not found on this machine`, "error");
  } catch (err) {
    toast(err.message, "error");
  }
}

tabsEl.addEventListener("click", async event => {
  const closeId = event.target.closest("[data-close]")?.dataset.close;
  if (closeId) {
    event.stopPropagation();
    const server = state.servers.find(s => s.id === closeId);
    if (!server) return;
    if (!(await confirmDelete(server))) return;
    try {
      await api(`/api/servers/${closeId}`, { method: "DELETE" });
      if (state.activeId === closeId) state.activeId = null;
      toast(`Deleted ${server.profile}`);
      await refreshState();
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const tab = event.target.closest(".tab");
  if (!tab) return;
  state.activeId = tab.dataset.id;
  render();
});

let dragId = null;
tabsEl.addEventListener("dragstart", event => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  dragId = tab.dataset.id;
  event.dataTransfer.effectAllowed = "move";
});
tabsEl.addEventListener("dragover", event => {
  event.preventDefault();
});
tabsEl.addEventListener("drop", async event => {
  event.preventDefault();
  const tab = event.target.closest(".tab");
  if (!tab || !dragId || dragId === tab.dataset.id) return;
  const ids = [...state.servers].sort((a, b) => a.order - b.order).map(s => s.id);
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(tab.dataset.id);
  if (from < 0 || to < 0) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  try {
    const data = await api("/api/servers/reorder", { method: "POST", body: { ids } });
    state.servers = data.servers || state.servers;
    render();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    dragId = null;
  }
});

document.getElementById("btn-add").addEventListener("click", async () => {
  try {
    const server = await api("/api/servers", { method: "POST", body: { profile: "New Server" } });
    state.activeId = server.id;
    toast("Created New Server", "success");
    await refreshState();
  } catch (err) {
    toast(err.message, "error");
  }
});

document.getElementById("btn-theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
});

function applyTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = value;
  localStorage.setItem("icarus-theme", value);
  const btn = document.getElementById("btn-theme");
  if (btn) btn.textContent = value === "light" ? "Dark" : "Light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = value === "light" ? "#f4f1ea" : "#10141c";
}

applyTheme(localStorage.getItem("icarus-theme") === "light" ? "light" : "dark");

document.getElementById("btn-info").addEventListener("click", () => {
  const lans = (window.__icarusHost?.lanAddresses || []).map(ip => `http://${ip}:${window.__icarusHost.managerPort || 3230}`);
  const p = infoDialog.querySelector(".muted");
  if (p) {
    p.textContent = lans.length
      ? `Any IP can connect. Examples: ${lans.join(" · ")}`
      : "Listening on all interfaces (0.0.0.0). Use this PC's IP and port 3230 from other devices.";
  }
  infoDialog.showModal();
});
document.getElementById("btn-copy-settings").addEventListener("click", () => {
  if (state.servers.length < 2) {
    toast("You need at least two server profiles to copy settings", "error");
    return;
  }
  const from = document.getElementById("copy-from");
  const to = document.getElementById("copy-to");
  const options = state.servers.map(s => `<option value="${s.id}">${escapeHtml(s.profile)}</option>`).join("");
  from.innerHTML = options;
  to.innerHTML = options;
  if (state.servers[1]) to.value = state.servers[1].id;
  copyDialog.showModal();
});

document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => btn.closest("dialog")?.close());
});

document.getElementById("copy-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    fromId: form.fromId.value,
    toId: form.toId.value,
    flags: {
      launchArgs: form.launchArgs.checked,
      autoStart: form.autoStart.checked,
      shutdown: form.shutdown.checked,
      backup: form.backup.checked,
      logs: form.logs.checked,
      configFiles: form.configFiles.checked
    }
  };
  try {
    await api("/api/servers/copy-settings", { method: "POST", body });
    copyDialog.close();
    toast("Settings copied", "success");
    await refreshState();
  } catch (err) {
    toast(err.message, "error");
  }
});

workspace.addEventListener("click", async event => {
  const toggle = event.target.closest(".section-toggle");
  if (toggle) {
    const section = toggle.closest(".section");
    const key = section?.dataset.section;
    const server = activeServer();
    if (!server || !key) return;
    const full = `${server.id}:${key}`;
    if (state.openSections.has(full)) state.openSections.delete(full);
    else state.openSections.add(full);
    section.classList.toggle("open");
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const server = activeServer();
  if (!server) return;

  try {
    if (action === "toggle") {
      if (String(server.status).toLowerCase() === "running") {
        await withBusy(server.id, async () => {
          await api(`/api/servers/${server.id}/stop`, { method: "POST" });
          toast(`Stopped ${server.profile}`);
        });
      } else {
        const started = await startServerWithFirewallPrompt(server);
        if (started) toast(`Started ${server.profile}`, "success");
      }
    } else if (action === "update") {
      state.repairPrompted.delete(server.id);
      await api(`/api/servers/${server.id}/update`, { method: "POST", body: {} });
      toast("Update / Verify started — watch the Console panel", "success");
      connectConsole(server.id);
      await refreshState({ silent: true });
    } else if (action === "download-steamcmd") {
      toast("Downloading SteamCMD…");
      const result = await api("/api/steamcmd/download", { method: "POST", body: {} });
      schedulePatch(server.id, { steamcmd: result.path });
      toast(`SteamCMD ready at ${result.path}`, "success");
      await refreshState();
    } else if (action === "backup") {
      await withBusy(server.id, async () => {
        await api(`/api/servers/${server.id}/backup`, { method: "POST" });
        toast("Backup complete", "success");
      });
    } else if (action === "open-gus-ini") {
      await api(`/api/servers/${server.id}/open-ini`, { method: "POST", body: { kind: "settings" } });
      toast("Opened ServerSettings.ini");
    } else if (action === "validate-install") {
      await validatePath("install", "Install");
    } else if (action === "validate-steamcmd") {
      await validatePath("steamcmd", "SteamCMD");
    } else if (action === "validate-backup") {
      await validatePath("autoBackupDest", "Backup");
    } else if (action === "validate-logs") {
      await validatePath("logLocation", "Game log");
    } else if (action === "validate-update-logs") {
      await validatePath("updateLogLocation", "Update log");
    } else if (action === "console-clear") {
      const el = document.getElementById("console-output");
      if (el) el.innerHTML = `<div class="console-empty">Live Icarus log output will appear here…</div>`;
    } else if (action === "console-players") {
      await sendConsoleCommand(server.id, "ListPlayers", false);
    } else if (action === "console-getchat") {
      await sendConsoleCommand(server.id, "GetChat", false);
    }
  } catch (err) {
    toast(err.message, "error");
    await refreshState({ silent: true });
  }
});

async function sendConsoleCommand(serverId, command, asChat) {
  await api(`/api/servers/${serverId}/command`, {
    method: "POST",
    body: { command, asChat: Boolean(asChat) }
  });
}

workspace.addEventListener("submit", async event => {
  if (event.target?.id !== "console-form") return;
  event.preventDefault();
  const server = activeServer();
  if (!server) return;
  const input = document.getElementById("console-input");
  const asChat = document.getElementById("console-as-chat")?.checked;
  const command = input?.value?.trim();
  if (!command) return;
  input.value = "";
  try {
    await sendConsoleCommand(server.id, command, asChat);
  } catch (err) {
    toast(err.message, "error");
  }
});

workspace.addEventListener("input", event => {
  const el = event.target;
  const field = el.dataset.field;
  const server = activeServer();
  if (!field || !server) return;

  if (field === "autostartDays" || field === "shutdownDays") {
    const index = Number(el.dataset.index);
    const next = [...(server[field] || [false, false, false, false, false, false, false])];
    next[index] = el.checked;
    schedulePatch(server.id, { [field]: next });
    return;
  }

  if (el.type === "checkbox") {
    schedulePatch(server.id, { [field]: el.checked });
    return;
  }

  let value = el.value;
  if (field === "autostartTime" || field === "shutdownTime") value = fromTimeInput(value);
  schedulePatch(server.id, { [field]: value });
});

await refreshState();
state.busy.clear();
state.pollTimer = setInterval(() => refreshState({ silent: true }), 2000);
