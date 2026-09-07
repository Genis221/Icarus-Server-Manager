const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const INTERVALS = ["30 mins", "1 hr", "2 hrs", "4 hrs", "6 hrs", "12 hrs", "24 hrs"];
const PROSPECT_TYPES = [
  ["OpenWorld_Styx", "Open World — Styx"],
  ["OpenWorld_Olympus", "Open World — Olympus"],
  ["OpenWorld_Prometheus", "Open World — Prometheus"],
  ["Olympus_Outpost", "Outpost — Olympus"],
  ["Olympus", "Olympus"],
  ["Outpost002_Forest", "Outpost — Arcwood"],
  ["Outpost003_Arctic", "Outpost — Iceholm"],
  ["Outpost005_Forest", "Outpost — Holdfast"],
  ["Outpost006_Olympus", "Outpost — Olympus (alt)"],
  ["Prometheus", "Prometheus"],
  ["Styx", "Styx"]
];

const state = {
  servers: [],
  activity: [],
  activeId: null,
  pollTimer: null,
  saveTimers: new Map(),
  pendingPatches: new Map(),
  openSections: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem("icarus-open-sections") || "null");
      if (Array.isArray(raw) && raw.length) return new Set(raw);
    } catch { /* ignore */ }
    return new Set();
  })(),
  busy: new Set(),
  repairPrompted: new Set(),
  consoleSource: null,
  consoleServerId: null,
  panel: localStorage.getItem("icarus-panel") === "console" ? "console" : "overview"
};

const workspace = document.getElementById("workspace");
const tabsEl = document.getElementById("tabs");
const toastStack = document.getElementById("toast-stack");
const infoDialog = document.getElementById("info-dialog");
const importDialog = document.getElementById("import-dialog");
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
  if (patch.icarus) {
    server.icarus = { ...(server.icarus || {}), ...patch.icarus };
    patch = { ...patch, icarus: { ...server.icarus } };
  }
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
      <span class="tab-copy">
        <b>${escapeHtml(server.profile || "New Server")}</b>
        <small>${escapeHtml(statusDisplay(server).label)}</small>
      </span>
      <span class="close" data-close="${server.id}" title="Remove">×</span>
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
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.appendChild(line);
  while (el.children.length > 600) el.removeChild(el.firstChild);
  if (stick) el.scrollTop = el.scrollHeight;
}

function playerInitials(name) {
  const parts = String(name || "").trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  const cleaned = String(name || "").replace(/[^A-Za-z0-9]/g, "");
  return (cleaned.slice(0, 2) || "?").toUpperCase();
}

function playerRosterHtml(server) {
  const count = Number(server.players) || 0;
  const list = Array.isArray(server.playersOnline) && server.playersOnline.length
    ? server.playersOnline
    : [];
  if (!count && !list.length) {
    return `<p class="player-empty">Nobody online</p>`;
  }
  if (!list.length) {
    return `<p class="player-empty">${escapeHtml(String(count))} in session</p>`;
  }
  return list.map(player => {
    const name = typeof player === "string" ? player : player.name;
    const ping = typeof player === "object" ? Number(player.ping) : NaN;
    const pingHtml = Number.isFinite(ping) && ping > 0
      ? `<span class="player-ping">${escapeHtml(String(Math.round(ping)))}ms</span>`
      : "";
    const hue = [...String(name || "")].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % 360;
    return `<div class="player-row">
      <span class="player-avatar" style="--h:${hue}">${escapeHtml(playerInitials(name))}</span>
      <span class="player-name">${escapeHtml(name || "Player")}</span>
      ${pingHtml}
    </div>`;
  }).join("");
}

function rconHint(server) {
  const rcon = server.rcon || {};
  if (!rcon.hasPassword && !server.icarus?.adminPassword) return "Set Admin Password below, then use in-game /AdminLogin";
  return "Admin commands are in-game: /AdminLogin, /AdminSay, /KickPlayer, /ReturnToLobby";
}

function prospectTypeOptions(selected) {
  const value = selected || "OpenWorld_Styx";
  const known = new Set(PROSPECT_TYPES.map(([id]) => id));
  const extra = known.has(value) ? "" : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`;
  return extra + PROSPECT_TYPES.map(([id, label]) =>
    `<option value="${escapeHtml(id)}" ${id === value ? "selected" : ""}>${escapeHtml(label)}</option>`
  ).join("");
}

function staticTile(title, body) {
  return `<article class="tile">
    <h2>${title}</h2>
    ${body}
  </article>`;
}

function collapsibleTile(id, title, body) {
  const open = state.openSections.has(id);
  return `<article class="tile collapsible ${open ? "is-open" : ""}" data-section="${id}">
    <button type="button" class="tile-toggle" data-action="toggle-section" data-section="${id}" aria-expanded="${open ? "true" : "false"}">
      <h2>${title}</h2>
      <span class="tile-chevron" aria-hidden="true"></span>
    </button>
    <div class="tile-body">${body}</div>
  </article>`;
}

function renderServer(server) {
  if (!server) {
    workspace.innerHTML = `<div class="empty-view"><p>No server profiles yet.</p></div>`;
    return;
  }
  const running = String(server.status).toLowerCase() === "running";
  const updating = String(server.status).toLowerCase() === "updating";
  const busy = state.busy.has(server.id) || updating;
  const statusUi = statusDisplay(server);
  const icarus = server.icarus || {};
  const panel = state.panel === "console" ? "console" : "overview";

  workspace.innerHTML = `
    <div class="server-page" data-server-id="${server.id}" data-panel="${panel}" data-prospect="${escapeHtml(icarus.prospectMode || "resume")}">
      <header class="command-bar">
        <label class="field profile-field">
          <span>Active prospect</span>
          <input data-field="profile" value="${escapeHtml(server.profile)}" maxlength="80" />
        </label>
        <nav class="panel-nav" aria-label="Workspace">
          <button type="button" class="panel-btn" data-panel="overview">Overview</button>
          <button type="button" class="panel-btn" data-panel="console">Live log</button>
        </nav>
        <div class="controls-row">
          <button type="button" class="btn ${running ? "stop" : "start"}" data-action="toggle" ${busy ? "disabled" : ""}>
            ${running ? "Stop" : "Start"}
          </button>
          <button type="button" class="btn primary" data-action="update" ${busy ? "disabled" : ""}>Update / Verify</button>
        </div>
      </header>

      <section class="panel-view" data-view="overview">
        <div class="hero ${statusUi.tone}">
          <div>
            <p class="hero-kicker">Session</p>
            <h1>${escapeHtml(server.profile)}</h1>
          </div>
          <div class="stats">
            <article class="stat-card ${statusUi.tone}">
              <span>Status</span>
              <strong>${escapeHtml(statusUi.label)}</strong>
            </article>
            <article class="stat-card ${availabilityClass(server.availability)}">
              <span>Availability</span>
              <strong>${escapeHtml(server.availability || "Offline")}</strong>
            </article>
            <article class="stat-card players-card ${Number(server.players) > 0 ? "good" : ""}">
              <span>Players</span>
              <strong>${Number(server.players) || 0} / ${Number(server.maxPlayers) || 8}</strong>
              <div class="player-roster">${playerRosterHtml(server)}</div>
            </article>
            <article class="stat-card ${firewallClass(server.firewallStatus)}">
              <span>Firewall</span>
              <strong>${escapeHtml(server.firewallStatus || "Not Checked")}</strong>
            </article>
          </div>
        </div>
        <div class="overview-stack">
          <div class="overview-pin">
            ${staticTile("Install", `
              <label class="field">
                <span>Installed Version</span>
                <input data-field="version" value="${escapeHtml(server.version || "")}" readonly />
              </label>
              <div class="field">
                <span class="field-label">Install Location</span>
                <div class="path-row">
                  <input class="inline-input" data-field="install" value="${escapeHtml(server.install || "")}" placeholder="C:\\IcarusDedicatedServer or ...\\IcarusServer.exe" />
                  <button type="button" class="btn secondary" data-action="attach-install">Attach</button>
                </div>
              </div>
              ${server.exe ? `<p class="field-hint">Running: ${escapeHtml(server.exe)}</p>` : `<p class="field-hint">Point this at the folder that contains IcarusServer.exe, then Attach.</p>`}
            `)}
            ${staticTile("SteamCMD", `
              <div class="field">
                <span class="field-label">SteamCMD folder</span>
                <input class="inline-input" data-field="steamcmd" value="${escapeHtml(server.steamcmd || "")}" placeholder="C:\\Users\\...\\Documents\\SteamCMD" />
              </div>
              <div class="action-row">
                <button type="button" class="btn primary" data-action="download-steamcmd">Download SteamCMD</button>
              </div>
            `)}
            ${staticTile("Launch", `
              <label class="field">
                <span>Launch Arguments</span>
                <input data-field="launchArgs" value="${escapeHtml(server.launchArgs || "")}" placeholder='-SteamServerName="My Icarus Server" -Port=17777 -QueryPort=27015 -Log' />
              </label>
            `)}
            ${staticTile("Prospect on start", `
              <p class="field-hint">Boot order is Load, then Resume, then Create. Empty lobby if none apply.</p>
              <label class="field">
                <span>Startup mode</span>
                <select data-icarus="prospectMode">
                  <option value="resume" ${icarus.prospectMode === "resume" ? "selected" : ""}>Resume last prospect</option>
                  <option value="load" ${icarus.prospectMode === "load" ? "selected" : ""}>Load a saved prospect</option>
                  <option value="create" ${icarus.prospectMode === "create" ? "selected" : ""}>Create a new prospect</option>
                  <option value="lobby" ${icarus.prospectMode === "lobby" ? "selected" : ""}>Lobby only</option>
                </select>
              </label>
              <label class="field"><span>Last prospect</span><input value="${escapeHtml(icarus.lastProspectName || "")}" readonly placeholder="Filled by the server after a run" /></label>
              <label class="field icarus-load"><span>Load prospect name</span><input data-icarus="loadProspect" value="${escapeHtml(icarus.loadProspect || "")}" placeholder="Exact save name" /></label>
              <div class="icarus-create">
                <label class="field">
                  <span>Create type</span>
                  <select data-icarus="createType">${prospectTypeOptions(icarus.createType)}</select>
                </label>
                <label class="field">
                  <span>Difficulty</span>
                  <select data-icarus="createDifficulty">
                    <option value="1" ${String(icarus.createDifficulty) === "1" ? "selected" : ""}>1 Easy</option>
                    <option value="2" ${String(icarus.createDifficulty) === "2" ? "selected" : ""}>2 Medium</option>
                    <option value="3" ${String(icarus.createDifficulty) === "3" ? "selected" : ""}>3 Hard</option>
                    <option value="4" ${String(icarus.createDifficulty) === "4" ? "selected" : ""}>4 Extreme</option>
                  </select>
                </label>
                <label class="field"><span>Save name</span><input data-icarus="createSave" value="${escapeHtml(icarus.createSave || "")}" placeholder="Required, e.g. MyBase" /></label>
                <label class="check-line"><input type="checkbox" data-icarus="createHardcore" ${icarus.createHardcore ? "checked" : ""} /> Hardcore (no respawn)</label>
              </div>
            `)}
            ${staticTile("Session", `
              <p class="field-hint">Written to ServerSettings.ini. SessionName is ignored by the game — the prospect name above becomes -SteamServerName.</p>
              <label class="field"><span>Join password</span><input data-icarus="joinPassword" type="text" autocomplete="off" value="${escapeHtml(icarus.joinPassword || "")}" placeholder="Leave empty for public" /></label>
              <label class="field"><span>Admin password</span><input data-icarus="adminPassword" type="text" autocomplete="off" value="${escapeHtml(icarus.adminPassword || "")}" placeholder="Required for /AdminLogin" /></label>
              <label class="field"><span>Max players</span><input data-icarus="maxPlayers" type="number" min="1" max="20" value="${escapeHtml(icarus.maxPlayers ?? 8)}" /></label>
              <label class="check-line"><input type="checkbox" data-icarus="stayOnline" ${icarus.stayOnline !== false ? "checked" : ""} /> Stay online when empty (ShutdownIf* = -1)</label>
            `)}
            ${staticTile("Ports", `
              <p class="field-hint">Game and Steam query (UDP). Bound on all interfaces. Forward both from your router for players outside the LAN; TCP copies are also opened in Windows Firewall.</p>
              <label class="field"><span>Game port</span><input data-icarus="gamePort" type="number" min="1024" max="65535" value="${escapeHtml(icarus.gamePort ?? 17777)}" /></label>
              <label class="field"><span>Query port</span><input data-icarus="queryPort" type="number" min="1024" max="65535" value="${escapeHtml(icarus.queryPort ?? 27015)}" /></label>
            `)}
          </div>
          <div class="overview-extras">
            ${collapsibleTile("lobby", "Lobby permissions", `
              <label class="check-line"><input type="checkbox" data-icarus="allowNonAdminsLaunch" ${icarus.allowNonAdminsLaunch !== false ? "checked" : ""} /> Non-admins can launch prospects</label>
              <label class="check-line"><input type="checkbox" data-icarus="allowNonAdminsDelete" ${icarus.allowNonAdminsDelete ? "checked" : ""} /> Non-admins can delete prospect saves</label>
            `)}
            ${collapsibleTile("autostart", "Automatic start", `
              <div class="day-row">${dayChecks("autostartDays", server.autostartDays)}</div>
              <label class="field"><span>Start Server at</span><input type="time" data-field="autostartTime" value="${escapeHtml(toTimeInput(server.autostartTime))}" /></label>
              <label class="check-line"><input type="checkbox" data-field="autostartUpdate" ${server.autostartUpdate ? "checked" : ""} /> Update before start</label>
            `)}
            ${collapsibleTile("shutdown", "Shutdown / restart", `
              <div class="day-row">${dayChecks("shutdownDays", server.shutdownDays)}</div>
              <label class="field"><span>Shutdown at</span><input type="time" data-field="shutdownTime" value="${escapeHtml(toTimeInput(server.shutdownTime))}" /></label>
              <label class="check-line"><input type="checkbox" data-field="performUpdate" ${server.performUpdate ? "checked" : ""} /> Perform update</label>
              <label class="check-line"><input type="checkbox" data-field="thenRestart" ${server.thenRestart ? "checked" : ""} /> Then restart</label>
            `)}
            ${collapsibleTile("backups", "Prospect backups", `
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
                <input class="inline-input" data-field="autoBackupDest" value="${escapeHtml(server.autoBackupDest || "")}" />
              </div>
              <div class="action-row">
                <button type="button" class="btn primary" data-action="backup" ${server.backupInProgress ? "disabled" : ""}>Backup Now</button>
                <label class="check-line"><input type="checkbox" data-field="autoBackupEnabled" ${server.autoBackupEnabled ? "checked" : ""} /> Enable Auto Backup</label>
              </div>
            `)}
            ${collapsibleTile("mods", "Mods", `
              <p class="field-hint">Icarus\\Content\\Paks\\mods on this install. The folder is created if it is missing. Copy .pak files in, or delete them here.</p>
              <div class="config-file-list" id="mod-file-list"><p class="field-hint">Loading…</p></div>
              <div class="config-add-row">
                <label class="field">
                  <span>Copy from path</span>
                  <input id="mod-file-source" placeholder="C:\\Downloads\\MyMod.pak" />
                </label>
                <div class="action-row config-add-actions">
                  <button type="button" class="btn primary" data-action="mod-file-add">Add mod</button>
                  <button type="button" class="btn secondary" data-action="mod-open-folder">Open folder</button>
                </div>
              </div>
            `)}
            ${collapsibleTile("config-files", "Config files", `
              <p class="field-hint">Files in Icarus\\Saved\\Config\\WindowsServer. Green means the file is on disk. Add a missing INI, copy one in from a path, or delete it here.</p>
              <div class="config-file-list" id="config-file-list"><p class="field-hint">Loading…</p></div>
              <div class="config-add-row">
                <label class="field">
                  <span>Add file</span>
                  <select id="config-file-preset">
                    <option value="">Choose a file…</option>
                    <option value="ServerSettings.ini">ServerSettings.ini</option>
                    <option value="Engine.ini">Engine.ini</option>
                    <option value="Game.ini">Game.ini</option>
                    <option value="GameUserSettings.ini">GameUserSettings.ini</option>
                    <option value="Scalability.ini">Scalability.ini</option>
                    <option value="Input.ini">Input.ini</option>
                    <option value="DeviceProfiles.ini">DeviceProfiles.ini</option>
                    <option value="Admins.txt">Admins.txt</option>
                    <option value="__custom">Custom filename…</option>
                  </select>
                </label>
                <label class="field config-custom-name hidden" id="config-custom-wrap">
                  <span>Filename</span>
                  <input id="config-file-name" placeholder="MyMod.ini" />
                </label>
                <label class="field">
                  <span>Copy from path (optional)</span>
                  <input id="config-file-source" placeholder="C:\\path\\to\\Engine.ini" />
                </label>
                <div class="action-row config-add-actions">
                  <button type="button" class="btn primary" data-action="config-file-add">Add to server</button>
                </div>
              </div>
              <div class="field">
                <span class="field-label">Game Log Location</span>
                <input class="inline-input" data-field="logLocation" value="${escapeHtml(server.logLocation || "")}" />
              </div>
              <div class="field">
                <span class="field-label">Update Log Location</span>
                <input class="inline-input" data-field="updateLogLocation" value="${escapeHtml(server.updateLogLocation || "")}" />
              </div>
            `)}
          </div>
        </div>
      </section>

      <section class="panel-view" data-view="console">
        <section class="console-panel">
          <div class="console-toolbar">
            <strong class="console-title">Live log</strong>
            <div class="console-live-status" id="console-live-status" data-state="live"><i></i><b>Live</b></div>
            <span class="console-hint">${escapeHtml(rconHint(server))}</span>
            <div class="console-tools">
              <button type="button" class="btn secondary" data-action="console-clear">Clear</button>
            </div>
          </div>
          <div class="console-output" id="console-output"><div class="console-empty">Live Icarus log output will appear here…</div></div>
          <form class="console-command" id="console-form">
            <input id="console-input" type="text" autocomplete="off" spellcheck="false" placeholder="Command notes appear in this log" />
            <button type="submit" class="btn primary">Send</button>
          </form>
        </section>
      </section>
    </div>
  `;

  connectConsole(server.id);
  loadConfigFiles(server);
  loadModFiles(server);
}

function configFileListHtml(files, folder) {
  if (!Array.isArray(files) || !files.length) {
    return `<p class="field-hint">${folder ? escapeHtml(folder) : "No config folder yet."}</p>`;
  }
  const rows = files.map(file => {
    const present = Boolean(file.exists);
    const meta = present
      ? `${escapeHtml(file.sizeLabel || "0 B")}`
      : "Not on disk";
    const actions = present
      ? `<button type="button" class="btn secondary" data-action="config-file-open" data-name="${escapeHtml(file.name)}">Open</button>
         <button type="button" class="btn danger" data-action="config-file-delete" data-name="${escapeHtml(file.name)}">Delete</button>`
      : `<button type="button" class="btn primary" data-action="config-file-create" data-name="${escapeHtml(file.name)}">Add</button>`;
    return `<div class="config-file-row ${present ? "is-present" : "is-missing"}">
      <span class="config-file-status" title="${present ? "On disk" : "Missing"}"></span>
      <div class="config-file-meta">
        <b>${escapeHtml(file.name)}</b>
        <small>${meta}</small>
      </div>
      <div class="config-file-actions">${actions}</div>
    </div>`;
  }).join("");
  return `${rows}<p class="field-hint">${escapeHtml(folder || "")}</p>`;
}

async function loadConfigFiles(server) {
  const el = document.getElementById("config-file-list");
  if (!el || !server) return;
  if (!server.install) {
    el.innerHTML = `<p class="field-hint">Attach an install folder first.</p>`;
    return;
  }
  try {
    const data = await api(`/api/servers/${server.id}/config-files`);
    el.innerHTML = configFileListHtml(data.files || [], data.folder);
  } catch (err) {
    el.innerHTML = `<p class="field-hint">${escapeHtml(err.message)}</p>`;
  }
}

async function loadModFiles(server) {
  const el = document.getElementById("mod-file-list");
  if (!el || !server) return;
  if (!server.install) {
    el.innerHTML = `<p class="field-hint">Attach an install folder first.</p>`;
    return;
  }
  try {
    const data = await api(`/api/servers/${server.id}/mods`);
    const files = data.files || [];
    if (!files.length) {
      el.innerHTML = `<p class="field-hint">mods folder is ready. No .pak files yet.<br>${escapeHtml(data.folder || "")}</p>`;
      return;
    }
    el.innerHTML = files.map(file => `
      <div class="config-file-row is-present">
        <span class="config-file-status" title="On disk"></span>
        <div class="config-file-meta">
          <b>${escapeHtml(file.name)}</b>
          <small>${escapeHtml(file.sizeLabel || "0 B")}</small>
        </div>
        <div class="config-file-actions">
          <button type="button" class="btn danger" data-action="mod-file-delete" data-name="${escapeHtml(file.name)}">Delete</button>
        </div>
      </div>
    `).join("") + `<p class="field-hint">${escapeHtml(data.folder || "")}</p>`;
  } catch (err) {
    el.innerHTML = `<p class="field-hint">${escapeHtml(err.message)}</p>`;
  }
}

async function addConfigFileFromForm(server, name) {
  const preset = document.getElementById("config-file-preset");
  const custom = document.getElementById("config-file-name");
  const source = document.getElementById("config-file-source");
  const chosen = String(name || (preset?.value === "__custom" ? custom?.value : preset?.value) || "").trim();
  if (!chosen || chosen === "__custom") {
    toast("Choose or type a config filename", "error");
    return;
  }
  await api(`/api/servers/${server.id}/config-files`, {
    method: "POST",
    body: { name: chosen, source: String(source?.value || "").trim() }
  });
  toast(`Added ${chosen}`, "success");
  if (source) source.value = "";
  await loadConfigFiles(server);
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
    const focusKey = prevFocus?.dataset?.icarus
      ? `${prevFocus.closest("[data-server-id]")?.dataset.serverId}:icarus:${prevFocus.dataset.icarus}`
      : prevFocus?.dataset?.field
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
        field === "icarus"
          ? `[data-server-id="${id}"] [data-icarus="${index}"]`
          : index !== ""
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
    if (strong) strong.textContent = `${playerCount} / ${Number(server.maxPlayers) || 8}`;
    setStatTone(cards[2], playerCount > 0 ? "good" : "");
    const roster = cards[2].querySelector(".player-roster");
    if (roster) roster.innerHTML = playerRosterHtml(server);
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

async function confirmDanger(title, message) {
  return new Promise(resolve => {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
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

async function confirmDelete(server) {
  return confirmDanger(
    "Delete Server Profile",
    `Delete profile "${server.profile}"? This does not delete server files on disk.`
  );
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

let importPreview = null;
let importPollTimer = null;

function importModeLabel(mode) {
  return ({ resume: "Resume last prospect", load: "Load prospect", create: "Create prospect", lobby: "Lobby" })[mode] || mode;
}

function renderImportPreview(preview) {
  const el = document.getElementById("import-preview");
  importPreview = preview;
  const icarus = preview.icarus || {};
  el.classList.remove("hidden");
  el.innerHTML = `
    <div><b>${escapeHtml(preview.profile || "Imported Server")}</b></div>
    <div>Install: ${escapeHtml(preview.install)}</div>
    <div>Size: ${escapeHtml(preview.sizeLabel || "unknown")} · ${Number(preview.files) || 0} files${preview.copyAllowed === false ? " · too large to copy (use in place)" : ""}</div>
    <div>Players: ${escapeHtml(icarus.maxPlayers ?? 8)} · Ports: ${escapeHtml(icarus.gamePort ?? 17777)} / ${escapeHtml(icarus.queryPort ?? 27015)}</div>
    <div>Startup: ${escapeHtml(importModeLabel(icarus.prospectMode))}${icarus.lastProspectName ? ` · Last: ${escapeHtml(icarus.lastProspectName)}` : ""}</div>
    <div>Join password: ${icarus.joinPassword ? "set" : "none"} · Admin password: ${icarus.adminPassword ? "set" : "none"}</div>
    <div>Settings.ini: ${preview.hasSettings ? "found" : "not found yet"}</div>
  `;
  const name = document.getElementById("import-profile");
  if (name && !name.value.trim()) name.value = preview.profile || "";
  const copy = document.getElementById("import-copy");
  if (copy && preview.copyAllowed === false) copy.checked = false;
  document.getElementById("import-dest-wrap")?.classList.toggle("hidden", !document.getElementById("import-copy")?.checked);
}

async function scanImportSource() {
  const source = document.getElementById("import-source")?.value?.trim();
  if (!source) {
    toast("Choose a server folder first", "error");
    return;
  }
  try {
    toast("Reading install…");
    const preview = await api("/api/import/inspect", { method: "POST", body: { source } });
    renderImportPreview(preview);
    toast("Settings loaded", "success");
  } catch (err) {
    importPreview = null;
    document.getElementById("import-preview")?.classList.add("hidden");
    toast(err.message, "error");
  }
}

function setImportProgress(job) {
  const wrap = document.getElementById("import-progress");
  const fill = document.getElementById("import-progress-fill");
  const text = document.getElementById("import-progress-text");
  wrap?.classList.remove("hidden");
  const percent = Number(job.percent) || 0;
  if (fill) fill.style.width = `${percent}%`;
  if (text) {
    if (job.status === "copying") {
      text.textContent = `Copying ${job.sizeLabel || "0 B"} of ${job.totalLabel || "?"} (${percent}%)`;
    } else if (job.status === "done") {
      text.textContent = "Import complete";
      if (fill) fill.style.width = "100%";
    } else if (job.status === "error") {
      text.textContent = job.error || "Import failed";
    } else {
      text.textContent = "Preparing import…";
    }
  }
}

document.getElementById("btn-import").addEventListener("click", () => {
  importPreview = null;
  if (importPollTimer) clearInterval(importPollTimer);
  importPollTimer = null;
  const form = document.getElementById("import-form");
  form?.reset();
  document.getElementById("import-preview")?.classList.add("hidden");
  document.getElementById("import-progress")?.classList.add("hidden");
  document.getElementById("import-dest-wrap")?.classList.add("hidden");
  document.getElementById("import-submit").disabled = false;
  importDialog.showModal();
});

document.getElementById("import-scan").addEventListener("click", () => scanImportSource());
document.getElementById("import-copy").addEventListener("change", event => {
  document.getElementById("import-dest-wrap")?.classList.toggle("hidden", !event.target.checked);
});

document.getElementById("import-form").addEventListener("submit", async event => {
  event.preventDefault();
  const source = document.getElementById("import-source").value.trim();
  const profile = document.getElementById("import-profile").value.trim();
  const copy = document.getElementById("import-copy").checked;
  const dest = document.getElementById("import-dest").value.trim();
  if (!source) {
    toast("Choose a server folder first", "error");
    return;
  }
  if (copy && !dest) {
    toast("Choose a destination folder for the copy", "error");
    return;
  }
  const submit = document.getElementById("import-submit");
  submit.disabled = true;
  try {
    const job = await api("/api/import/start", {
      method: "POST",
      body: { source, dest, copy, profile }
    });
    setImportProgress(job);
    if (job.status === "done" && job.server) {
      state.activeId = job.server.id;
      toast(`Imported ${job.server.profile}`, "success");
      importDialog.close();
      await refreshState();
      return;
    }
    if (importPollTimer) clearInterval(importPollTimer);
    importPollTimer = setInterval(async () => {
      try {
        const next = await api(`/api/import/jobs/${job.id}`);
        setImportProgress(next);
        if (next.status === "done") {
          clearInterval(importPollTimer);
          importPollTimer = null;
          if (next.server) state.activeId = next.server.id;
          toast(`Imported ${next.server?.profile || profile || "server"}`, "success");
          importDialog.close();
          submit.disabled = false;
          await refreshState();
        } else if (next.status === "error") {
          clearInterval(importPollTimer);
          importPollTimer = null;
          submit.disabled = false;
          toast(next.error || "Import failed", "error");
        }
      } catch (err) {
        clearInterval(importPollTimer);
        importPollTimer = null;
        submit.disabled = false;
        toast(err.message, "error");
      }
    }, 1000);
  } catch (err) {
    submit.disabled = false;
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
  if (meta) meta.content = value === "light" ? "#eef2f4" : "#07090d";
}

applyTheme(localStorage.getItem("icarus-theme") === "light" ? "light" : "dark");

document.getElementById("btn-info").addEventListener("click", () => {
  const lans = (window.__icarusHost?.lanAddresses || []).map(ip => `http://${ip}:${window.__icarusHost.managerPort || 3230}`);
  const p = infoDialog.querySelector(".muted");
  if (p) {
    p.textContent = lans.length
      ? `This PC and the internet can use the panel (forward TCP ${window.__icarusHost.managerPort || 3230}). LAN examples: ${lans.join(" · ")}`
      : "Listening on all interfaces (0.0.0.0). Forward TCP 3230 for the panel, and UDP game + query ports for Icarus.";
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
  const panelBtn = event.target.closest(".panel-btn[data-panel]");
  if (panelBtn && workspace.contains(panelBtn)) {
    const next = panelBtn.dataset.panel;
    if (["overview", "console"].includes(next)) {
      state.panel = next;
      localStorage.setItem("icarus-panel", next);
      const page = workspace.querySelector(".server-page");
      if (page) page.dataset.panel = next;
    }
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  if (action === "toggle-section") {
    const id = event.target.closest("[data-section]")?.dataset.section;
    if (!id) return;
    const tile = event.target.closest(".tile");
    if (state.openSections.has(id)) state.openSections.delete(id);
    else state.openSections.add(id);
    localStorage.setItem("icarus-open-sections", JSON.stringify([...state.openSections]));
    const open = state.openSections.has(id);
    tile?.classList.toggle("is-open", open);
    const btn = tile?.querySelector(".tile-toggle");
    if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    return;
  }

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
    } else if (action === "config-file-add") {
      await addConfigFileFromForm(server);
    } else if (action === "config-file-create") {
      const name = event.target.closest("[data-name]")?.dataset.name;
      await addConfigFileFromForm(server, name);
    } else if (action === "config-file-open") {
      const name = event.target.closest("[data-name]")?.dataset.name;
      await api(`/api/servers/${server.id}/config-files/open`, { method: "POST", body: { name } });
      toast(`Opened ${name}`);
    } else if (action === "config-file-delete") {
      const name = event.target.closest("[data-name]")?.dataset.name;
      const ok = await confirmDanger("Delete config file", `Delete ${name} from this server's WindowsServer config folder?`);
      if (!ok) return;
      await api(`/api/servers/${server.id}/config-files/delete`, { method: "POST", body: { name } });
      toast(`Deleted ${name}`);
      await loadConfigFiles(server);
    } else if (action === "mod-file-add") {
      const source = String(document.getElementById("mod-file-source")?.value || "").trim();
      if (!source) {
        toast("Paste the path to a .pak file", "error");
        return;
      }
      await api(`/api/servers/${server.id}/mods`, { method: "POST", body: { source } });
      toast("Mod added", "success");
      const input = document.getElementById("mod-file-source");
      if (input) input.value = "";
      await loadModFiles(server);
    } else if (action === "mod-file-delete") {
      const name = event.target.closest("[data-name]")?.dataset.name;
      const ok = await confirmDanger("Remove mod", `Delete ${name} from Icarus\\Content\\Paks\\mods?`);
      if (!ok) return;
      await api(`/api/servers/${server.id}/mods/delete`, { method: "POST", body: { name } });
      toast(`Removed ${name}`);
      await loadModFiles(server);
    } else if (action === "mod-open-folder") {
      await api(`/api/servers/${server.id}/mods/open-folder`, { method: "POST", body: {} });
      toast("Opened mods folder");
    } else if (action === "attach-install") {
      const target = String(server.install || "").trim();
      if (!target) {
        toast("Enter the Icarus folder or IcarusServer.exe path first", "error");
        return;
      }
      const attached = await api(`/api/servers/${server.id}/attach`, { method: "POST", body: { path: target } });
      const idx = state.servers.findIndex(s => s.id === server.id);
      if (idx >= 0) state.servers[idx] = { ...state.servers[idx], ...attached };
      toast(`Attached to ${attached.exe || attached.install}`, "success");
      await refreshState();
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

function applyControlPatch(el) {
  const server = activeServer();
  if (!server) return;

  if (el.dataset.icarus) {
    const key = el.dataset.icarus;
    const numeric = ["maxPlayers", "gamePort", "queryPort", "createDifficulty"].includes(key);
    const value = el.type === "checkbox" ? el.checked : (numeric ? Number(el.value) : el.value);
    schedulePatch(server.id, { icarus: { [key]: value } });
    if (key === "prospectMode") {
      el.closest(".server-page")?.setAttribute("data-prospect", String(value));
    }
    return;
  }

  const field = el.dataset.field;
  if (!field) return;

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
}

workspace.addEventListener("input", event => applyControlPatch(event.target));
workspace.addEventListener("change", event => {
  const el = event.target;
  if (el?.id === "config-file-preset") {
    document.getElementById("config-custom-wrap")?.classList.toggle("hidden", el.value !== "__custom");
    return;
  }
  if (el?.dataset?.icarus || el?.tagName === "SELECT") applyControlPatch(el);
});

await refreshState();
state.busy.clear();
state.pollTimer = setInterval(() => refreshState({ silent: true }), 2000);
