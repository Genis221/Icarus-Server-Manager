import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import dgram from "node:dgram";
import { createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.ICARUS_DATA_DIR || path.join(ROOT, "data"));
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LEGACY_CONFIG = path.join(ROOT, "config.json");
const PORT = Number(process.env.ICARUS_PORT || process.env.PORT || 3230);
const HOST = process.env.ICARUS_HOST || "0.0.0.0";
const ALLOW_REMOTE = process.env.ICARUS_ALLOW_REMOTE !== "false";
const ALLOW_PUBLIC = process.env.ICARUS_ALLOW_PUBLIC !== "false";
const MAX_BODY = 4 * 1024 * 1024;
const STEAM_APP_ID = "2089300";
const STEAMCMD_URL = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
const EXE_NAME = "IcarusServer-Win64-Shipping.exe";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BACKUP_INTERVALS = {
  "30 mins": 30,
  "1 hr": 60,
  "2 hrs": 120,
  "4 hrs": 240,
  "6 hrs": 360,
  "12 hrs": 720,
  "24 hrs": 1440
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/svg+xml",
  ".jpeg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml"
};

let state;
const runtimes = new Map();
let saveTimer = null;
let automationRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function defaultDays() {
  return [false, false, false, false, false, false, false];
}

function normalizeDays(value) {
  if (!Array.isArray(value) || value.length !== 7) return defaultDays();
  return value.map(Boolean);
}

function makeServer(partial = {}) {
  return {
    id: partial.id || randomUUID(),
    profile: String(partial.profile || partial.name || "New Server").trim() || "New Server",
    install: String(partial.install || partial.folder || "").trim(),
    steamcmd: String(partial.steamcmd || "").trim(),
    version: String(partial.version || "").trim(),
    launchArgs: String(partial.launch_args ?? partial.launchArgs ?? "").trim() || defaultLaunchArgs(partial.profile || partial.name || "New Server"),
    autostartDays: normalizeDays(partial.autostart_days ?? partial.autostartDays),
    autostartTime: String(partial.autostart_time ?? partial.autostartTime ?? "09:00"),
    autostartUpdate: Boolean(partial.autostart_update ?? partial.autostartUpdate),
    shutdownDays: normalizeDays(partial.shutdown_days ?? partial.shutdownDays),
    shutdownTime: String(partial.shutdown_time ?? partial.shutdownTime ?? "08:00"),
    performUpdate: Boolean(partial.perform_update ?? partial.performUpdate),
    thenRestart: Boolean(partial.then_restart ?? partial.thenRestart),
    autoBackupEnabled: Boolean(partial.auto_backup_enabled ?? partial.autoBackupEnabled),
    autoBackupInterval: String(partial.auto_backup_interval ?? partial.autoBackupInterval ?? "30 mins"),
    autoBackupDest: String(partial.auto_backup_dest ?? partial.autoBackupDest ?? "").trim(),
    backupLimit: String(partial.backup_limit ?? partial.backupLimit ?? "10"),
    logLocation: String(partial.log_location ?? partial.logLocation ?? "").trim(),
    updateLogLocation: String(partial.update_log_location ?? partial.updateLogLocation ?? "").trim(),
    firewallStatus: String(partial.firewallStatus || "Not Checked"),
    firewallAutoApproved: Boolean(partial.firewallAutoApproved),
    lastBackupAt: partial.lastBackupAt || null,
    order: Number.isFinite(Number(partial.order)) ? Number(partial.order) : 0
  };
}

function fromLegacy(entry, index) {
  return makeServer({ ...entry, order: index });
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadState() {
  await ensureDataDir();
  let loadedFromState = false;
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const servers = Array.isArray(parsed.servers) ? parsed.servers.map((s, i) => makeServer({ ...s, order: s.order ?? i })) : [];
    state = { servers, activity: Array.isArray(parsed.activity) ? parsed.activity.slice(0, 100) : [] };
    loadedFromState = true;
  } catch {
    // fall through to legacy import
  }

  // Re-import desktop config.json when state is missing or still the empty default profile.
  const needsLegacyImport = !loadedFromState || (
    state.servers.length <= 1 &&
    !String(state.servers[0]?.install || "").trim() &&
    String(state.servers[0]?.profile || "").trim().toLowerCase() === "new server"
  );

  if (needsLegacyImport) {
    try {
      const raw = await readFile(LEGACY_CONFIG, "utf8");
      const parsed = JSON.parse(raw);
      const servers = Array.isArray(parsed.servers) ? parsed.servers.map(fromLegacy) : [];
      if (servers.length) {
        state = {
          servers,
          activity: [{ time: nowIso(), message: "Imported desktop config.json", level: "info" }]
        };
        await persistState(true);
        return;
      }
    } catch {
      // no legacy config
    }
  }

  if (!loadedFromState) {
    state = { servers: [makeServer()], activity: [] };
    await persistState(true);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistState(false).catch(console.error), 400);
}

async function persistState(force) {
  if (saveTimer && !force) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await ensureDataDir();
  const payload = JSON.stringify({ servers: state.servers, activity: state.activity.slice(0, 100) }, null, 2);
  await writeFile(STATE_FILE, payload, "utf8");
}

function addActivity(message, level = "info") {
  state.activity.unshift({ time: nowIso(), message, level });
  state.activity = state.activity.slice(0, 100);
  scheduleSave();
}

function getServer(id) {
  return state.servers.find(s => s.id === id);
}

function runtimeOf(id) {
  if (!runtimes.has(id)) {
    runtimes.set(id, {
      status: "stopped",
      availability: "Offline",
      players: 0,
      maxPlayers: 8,
      pid: null,
      startedAt: 0,
      updating: false,
      needsRepair: false,
      backupInProgress: false,
      autoStartTriggeredDate: "",
      shutdownTriggeredDate: "",
      consoleLogs: [],
      consoleNextId: 0,
      consoleStreams: new Set(),
      logWatch: null,
      logOffset: 0,
      chatPollTimer: null,
      lastChatRaw: ""
    });
  }
  const runtime = runtimes.get(id);
  runtime.consoleLogs ||= [];
  runtime.consoleStreams ||= new Set();
  return runtime;
}

function parseQueryPort(launchArgs) {
  const match = String(launchArgs || "").match(/QueryPort=(\d+)/i);
  return match ? Number(match[1]) : 27015;
}

function parseGamePort(launchArgs) {
  const match = String(launchArgs || "").match(/(?:^|[?&\s-])Port=(\d+)/i);
  return match ? Number(match[1]) : 17777;
}

function parseMaxPlayers(launchArgs) {
  const text = String(launchArgs || "");
  let match = text.match(/-MaxPlayers=(\d+)/i);
  if (match) return Number(match[1]);
  match = text.match(/MaxPlayers=(\d+)/i);
  return match ? Number(match[1]) : 8;
}

function exeCandidates(server) {
  const install = server.install || "";
  return [
    path.join(install, "Icarus", "Binaries", "Win64", EXE_NAME),
    path.join(install, EXE_NAME),
    path.join(install, "IcarusServer.exe")
  ];
}

function exePathFor(server) {
  return exeCandidates(server)[0];
}

async function resolveExePath(server) {
  for (const candidate of exeCandidates(server)) {
    if (await pathExists(candidate)) return candidate;
  }
  return exePathFor(server);
}

function settingsIniPath(server) {
  return path.join(server.install, "Icarus", "Saved", "Config", "WindowsServer", "ServerSettings.ini");
}

function gusIniPath(server) {
  return settingsIniPath(server);
}

function gameIniPath(server) {
  return settingsIniPath(server);
}

function savedArksPath(server) {
  return path.join(server.install, "Icarus", "Saved");
}

function defaultLaunchArgs(profile) {
  const name = String(profile || "New Server").replace(/"/g, "");
  return `-SteamServerName="${name}" -Port=17777 -QueryPort=27015 -Log`;
}

function applySteamServerName(launchArgs, profile) {
  const name = String(profile || "New Server").replace(/"/g, "");
  const args = String(launchArgs || "").trim();
  if (!args) return defaultLaunchArgs(name);
  if (/-SteamServerName=/i.test(args)) {
    return args.replace(/-SteamServerName=(?:"[^"]*"|[^\s]+)/i, `-SteamServerName="${name}"`);
  }
  return `-SteamServerName="${name}" ${args}`;
}

const DEFAULT_SERVER_SETTINGS = `[/Script/Icarus.DedicatedServerSettings]
SessionName=
JoinPassword=
MaxPlayers=8
AdminPassword=
ShutdownIfNotJoinedFor=-1
ShutdownIfEmptyFor=-1
AllowNonAdminsToLaunchProspects=True
AllowNonAdminsToDeleteProspects=False
LoadProspect=
CreateProspect=
ResumeProspect=True
LastProspectName=
`;

async function ensureServerSettings(server) {
  const iniPath = settingsIniPath(server);
  await mkdir(path.dirname(iniPath), { recursive: true });
  if (!(await pathExists(iniPath))) {
    await writeFile(iniPath, DEFAULT_SERVER_SETTINGS, "utf8");
  }
}

function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
}

function isPrivateLanAddress(address) {
  const ip = String(address || "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  return false;
}

function lanAddresses() {
  const results = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      results.push(entry.address);
    }
  }
  return results;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store"
  });
  res.end(data);
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function publicServer(server, rcon = null) {
  const runtime = runtimeOf(server.id);
  const {
    id, profile, install, steamcmd, version, launchArgs,
    autostartDays, autostartTime, autostartUpdate,
    shutdownDays, shutdownTime, performUpdate, thenRestart,
    autoBackupEnabled, autoBackupInterval, autoBackupDest, backupLimit,
    logLocation, updateLogLocation, firewallStatus, firewallAutoApproved, lastBackupAt, order
  } = server;
  return {
    id, profile, install, steamcmd, version, launchArgs,
    autostartDays, autostartTime, autostartUpdate,
    shutdownDays, shutdownTime, performUpdate, thenRestart,
    autoBackupEnabled, autoBackupInterval, autoBackupDest, backupLimit,
    logLocation, updateLogLocation, firewallStatus, firewallAutoApproved, lastBackupAt, order,
    status: runtime.updating ? "Updating" : runtime.status,
    availability: runtime.availability,
    players: runtime.players,
    maxPlayers: runtime.maxPlayers || parseMaxPlayers(server.launchArgs),
    pid: runtime.pid,
    backupInProgress: Boolean(runtime.backupInProgress),
    updating: Boolean(runtime.updating),
    needsRepair: Boolean(runtime.needsRepair),
    startedAt: runtime.startedAt || null,
    rcon
  };
}

async function getRconPublic(server) {
  try {
    const iniPath = settingsIniPath(server);
    if (!(await pathExists(iniPath))) return { enabled: false, inGameAdmin: true, hasPassword: false };
    const raw = await readFile(iniPath, "utf8");
    const passMatch = raw.match(/^AdminPassword\s*=\s*(.*)$/im);
    return {
      enabled: false,
      inGameAdmin: true,
      hasPassword: Boolean(passMatch ? String(passMatch[1]).trim() : "")
    };
  } catch {
    return { enabled: false, inGameAdmin: true, hasPassword: false };
  }
}

async function publicStateAsync() {
  const ordered = [...state.servers].sort((a, b) => a.order - b.order);
  const servers = await Promise.all(ordered.map(async server => publicServer(server, await getRconPublic(server))));
  return {
    host: {
      managerPort: PORT,
      bindHost: HOST,
      hostname: os.hostname(),
      lanAddresses: lanAddresses(),
      platform: process.platform,
      node: process.version
    },
    servers,
    activity: state.activity.slice(0, 40)
  };
}

function publicState() {
  const ordered = [...state.servers].sort((a, b) => a.order - b.order);
  return {
    host: {
      managerPort: PORT,
      bindHost: HOST,
      hostname: os.hostname(),
      lanAddresses: lanAddresses(),
      platform: process.platform,
      node: process.version
    },
    servers: ordered.map(server => publicServer(server, server._rconPublic || null)),
    activity: state.activity.slice(0, 40)
  };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function updateSessionName(iniPath, sessionName) {
  if (!(await pathExists(iniPath))) return;
  const raw = await readFile(iniPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let found = false;
  const next = lines.map(line => {
    if (line.trim().startsWith("SessionName=")) {
      found = true;
      return `SessionName=${sessionName}`;
    }
    return line;
  });
  if (!found) {
    const idx = next.findIndex(l => l.trim().toLowerCase() === "[sessionsettings]");
    if (idx >= 0) next.splice(idx + 1, 0, `SessionName=${sessionName}`);
    else next.push("[SessionSettings]", `SessionName=${sessionName}`);
  }
  await writeFile(iniPath, next.join("\n"), "utf8");
}

async function readRconSettings(iniPath) {
  const defaults = { enabled: false, port: 27020, password: "" };
  if (!(await pathExists(iniPath))) return defaults;
  const raw = await readFile(iniPath, "utf8");
  const enabled = /RCONEnabled\s*=\s*True/i.test(raw);
  const portMatch = raw.match(/RCONPort\s*=\s*(\d+)/i);
  const passMatch = raw.match(/ServerAdminPassword\s*=\s*(.*)$/im);
  return {
    enabled,
    port: portMatch ? Number(portMatch[1]) : 27020,
    password: passMatch ? String(passMatch[1]).trim() : ""
  };
}

async function readRconPort(iniPath) {
  const settings = await readRconSettings(iniPath);
  return settings.port || null;
}

function encodeRconPacket(id, type, body) {
  const payload = Buffer.from(`${body}\0\0`, "utf8");
  const size = 4 + 4 + payload.length;
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

function decodeRconPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || buffer.length - offset < 4 + size) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const bodyEnd = offset + 4 + size - 2;
    const body = buffer.toString("utf8", offset + 12, bodyEnd);
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

function rconExec(host, port, password, command, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    let response = "";
    const authId = 1;
    const cmdId = 2;
    const endId = 3;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      if (authed) finish(null, response.trim());
      else finish(new Error("RCON timed out"));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(encodeRconPacket(authId, 3, password || ""));
    });

    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeRconPackets(buffer);
      buffer = decoded.rest;
      for (const packet of decoded.packets) {
        if (!authed) {
          if (packet.id === -1) return finish(new Error("RCON authentication failed — check ServerAdminPassword"));
          if (packet.id === authId) {
            authed = true;
            socket.write(encodeRconPacket(cmdId, 2, command));
            socket.write(encodeRconPacket(endId, 0, ""));
          }
          continue;
        }
        if (packet.id === endId) return finish(null, response.trim());
        if (packet.id === cmdId || packet.type === 0) response += packet.body;
      }
    });

    socket.on("error", err => finish(err));
    socket.on("close", () => {
      if (!settled) {
        if (authed) finish(null, response.trim());
        else finish(new Error("RCON connection closed"));
      }
    });
  });
}

function appendConsoleLog(serverId, message, level = "info") {
  const runtime = runtimeOf(serverId);
  runtime.consoleNextId = Number(runtime.consoleNextId || 0) + 1;
  const entry = {
    id: runtime.consoleNextId,
    time: nowIso(),
    level,
    message: String(message).slice(0, 4000)
  };
  runtime.consoleLogs.push(entry);
  if (runtime.consoleLogs.length > 800) runtime.consoleLogs = runtime.consoleLogs.slice(-800);
  for (const res of runtime.consoleStreams) {
    try {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch {
      runtime.consoleStreams.delete(res);
    }
  }
  return entry;
}

function shooterLogPath(server) {
  return path.join(server.install || "", "Icarus", "Saved", "Logs", "Icarus.log");
}

async function ensureLogWatch(server) {
  const runtime = runtimeOf(server.id);
  const filePath = shooterLogPath(server);
  if (!server.install || !(await pathExists(filePath))) return;

  if (runtime.logWatch) return;

  try {
    const st = await stat(filePath);
    runtime.logOffset = st.size;
  } catch {
    runtime.logOffset = 0;
  }

  const pull = async () => {
    try {
      if (!(await pathExists(filePath))) return;
      const st = await stat(filePath);
      if (st.size < runtime.logOffset) runtime.logOffset = 0;
      if (st.size === runtime.logOffset) return;
      const fh = await open(filePath, "r");
      try {
        const length = st.size - runtime.logOffset;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, runtime.logOffset);
        runtime.logOffset = st.size;
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) appendConsoleLog(server.id, line, "log");
        }
      } finally {
        await fh.close();
      }
    } catch {
      // ignore transient read errors
    }
  };

  runtime.logWatch = watch(filePath, () => { pull(); });
  runtime.logWatch.on("error", () => {
    try { runtime.logWatch.close(); } catch { /* ignore */ }
    runtime.logWatch = null;
  });
  await pull();
}

function stopLogWatch(serverId) {
  const runtime = runtimeOf(serverId);
  if (runtime.logWatch) {
    try { runtime.logWatch.close(); } catch { /* ignore */ }
    runtime.logWatch = null;
  }
  if (runtime.chatPollTimer) {
    clearInterval(runtime.chatPollTimer);
    runtime.chatPollTimer = null;
  }
}

async function ensureChatPoll(server) {
  const runtime = runtimeOf(server.id);
  if (runtime.chatPollTimer) return;
  runtime.chatPollTimer = setInterval(async () => {
    if (!runtime.consoleStreams.size) return;
    if (String(runtime.status).toLowerCase() !== "running") return;
    try {
      const settings = await readRconSettings(gusIniPath(server));
      if (!settings.enabled || !settings.password) return;
      const chat = await rconExec("127.0.0.1", settings.port, settings.password, "GetChat", 4000);
      if (!chat || chat === runtime.lastChatRaw) return;
      const previous = runtime.lastChatRaw || "";
      runtime.lastChatRaw = chat;
      const next = chat.startsWith(previous) ? chat.slice(previous.length) : chat;
      for (const line of next.split(/\r?\n/)) {
        if (line.trim()) appendConsoleLog(server.id, `[CHAT] ${line.trim()}`, "chat");
      }
    } catch {
      // RCON may be unavailable during startup
    }
  }, 4000);
}

function openConsoleStream(req, res, server) {
  const runtime = runtimeOf(server.id);
  const since = Math.max(0, Number(req.headers["last-event-id"] || 0) || 0);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1500\n\n");
  for (const entry of runtime.consoleLogs) {
    if (entry.id > since) res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  runtime.consoleStreams.add(res);
  ensureLogWatch(server).catch(() => {});
  ensureChatPoll(server).catch(() => {});
  const keepAlive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 15000);
  req.on("close", () => {
    clearInterval(keepAlive);
    runtime.consoleStreams.delete(res);
  });
}

async function getArkVersionFromLogs(install) {
  const logsDir = path.join(install, "Icarus", "Saved", "Logs");
  if (!(await pathExists(logsDir))) return "Unknown";
  const entries = await readdir(logsDir);
  const logs = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".log")) continue;
    const full = path.join(logsDir, name);
    const st = await stat(full);
    logs.push({ full, mtime: st.mtimeMs });
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  const pattern = /(?:Log Icarus|Engine Version|Icarus Version)[:\s]+([\d.]+)/i;
  for (const log of logs.slice(0, 5)) {
    const fh = await open(log.full, "r");
    try {
      const stream = fh.createReadStream({ encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const match = pattern.exec(line);
        if (match) return match[1];
      }
    } finally {
      await fh.close();
    }
  }
  return "Unknown";
}

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return [buf.toString("utf8", offset, end), end + 1];
}

function queryA2sInfo(host, port, timeoutMs = 700) {
  return new Promise(resolve => {
    const sock = dgram.createSocket("udp4");
    const request = Buffer.concat([
      Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
      Buffer.from("TSource Engine Query\0", "ascii")
    ]);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("message", msg => {
      try {
        if (msg.length >= 9 && msg[4] === 0x41) {
          sock.send(Buffer.concat([request, msg.subarray(5, 9)]), port, host);
          return;
        }
        if (msg.length < 6 || msg[4] !== 0x49) return;
        let offset = 6;
        let name, mapName;
        [name, offset] = readCString(msg, offset);
        [mapName, offset] = readCString(msg, offset);
        [, offset] = readCString(msg, offset);
        [, offset] = readCString(msg, offset);
        offset += 2;
        if (offset + 2 > msg.length) return;
        finish({
          name,
          map: mapName,
          players: msg[offset],
          max_players: msg[offset + 1]
        });
      } catch {
        // keep waiting until timeout
      }
    });
    sock.on("error", () => finish(null));
    sock.send(request, port, host, err => {
      if (err) finish(null);
    });
  });
}

async function queryLocalA2s(port) {
  // Prefer loopback first — ASA often ignores Steam query entirely, so keep this cheap.
  const hosts = ["127.0.0.1"];
  const lan = lanAddresses();
  if (lan[0]) hosts.push(lan[0]);
  const seen = new Set();
  for (const host of hosts) {
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const info = await queryA2sInfo(host, port, 600);
    if (info) return info;
  }
  return null;
}

async function readLogTail(filePath, maxBytes = 256 * 1024) {
  if (!(await pathExists(filePath))) return "";
  const fh = await open(filePath, "r");
  try {
    const st = await fh.stat();
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

async function detectReadyFromLogs(install) {
  const logPath = path.join(install || "", "Icarus", "Saved", "Logs", "Icarus.log");
  const text = await readLogTail(logPath);
  if (!text) return false;
  return /server has completed startup|set as ready for clients|full startup|startup is complete|steady state|server is ready|server ready/i.test(text);
}

let processCache = { at: 0, procs: [] };
let runtimeRefreshPromise = null;

async function listArkProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='IcarusServer-Win64-Shipping.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
      ],
      { windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(r => r && r.ProcessId)
      .map(r => ({
        pid: Number(r.ProcessId),
        exe: String(r.ExecutablePath || "")
      }));
  } catch {
    return [];
  }
}

async function getArkProcessesCached(maxAgeMs = 2500) {
  if (Date.now() - processCache.at < maxAgeMs) return processCache.procs;
  processCache.procs = await listArkProcesses();
  processCache.at = Date.now();
  return processCache.procs;
}

async function findProcessForInstall(install, procs = null) {
  if (!install) return null;
  const target = path.normalize(install).toLowerCase();
  const list = procs || await getArkProcessesCached();
  return list.find(p => path.normalize(p.exe || "").toLowerCase().includes(target)) || null;
}

function countPlayersFromListPlayers(text) {
  const raw = String(text || "").trim();
  if (!raw || /no players/i.test(raw)) return 0;
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const numbered = lines.filter(line => /^\d+\./.test(line));
  if (numbered.length) return numbered.length;
  return lines.filter(line => !/^(listplayers|players on server)/i.test(line)).length;
}

async function queryPlayerCountViaRcon(server) {
  try {
    const settings = await readRconSettings(gusIniPath(server));
    if (!settings.enabled || !settings.password) return null;
    const reply = await rconExec("127.0.0.1", settings.port, settings.password, "ListPlayers", 3500);
    return countPlayersFromListPlayers(reply);
  } catch {
    return null;
  }
}

async function refreshRuntime(server, { deep = false, procs = null } = {}) {
  const runtime = runtimeOf(server.id);
  if (runtime.updating) {
    runtime.status = "Updating";
    return;
  }
  const match = await findProcessForInstall(server.install, procs);
  runtime.maxPlayers = parseMaxPlayers(server.launchArgs);
  if (match) {
    runtime.status = "running";
    runtime.pid = match.pid;
    if (!runtime.startedAt) runtime.startedAt = Date.now();

    if (!deep) {
      // Fast path for API responses — never block on A2S/log I/O.
      if (runtime.availability === "Offline" || !runtime.availability) {
        runtime.availability = runtime.startedAt && Date.now() - runtime.startedAt < 8 * 60 * 1000
          ? "Starting…"
          : "Online";
      }
      return;
    }

    const info = await queryLocalA2s(parseQueryPort(server.launchArgs));
    if (info) {
      runtime.availability = "Online";
      runtime.players = Number(info.players) || 0;
      runtime.maxPlayers = Number(info.max_players) || runtime.maxPlayers;
      return;
    }

    // ASA often ignores A2S — fall back to RCON ListPlayers for live counts.
    const rconPlayers = await queryPlayerCountViaRcon(server);
    if (rconPlayers != null) {
      runtime.players = rconPlayers;
    }

    const ready = await detectReadyFromLogs(server.install);
    if (ready) {
      runtime.availability = "Online";
      return;
    }
    if (runtime.startedAt && Date.now() - runtime.startedAt < 8 * 60 * 1000) {
      runtime.availability = "Starting…";
    } else {
      runtime.availability = "Online";
    }
  } else {
    runtime.status = "stopped";
    runtime.pid = null;
    runtime.availability = "Offline";
    runtime.players = 0;
    runtime.startedAt = 0;
  }
}

async function refreshAllRuntimes({ deep = false } = {}) {
  const procs = await getArkProcessesCached(deep ? 0 : 2500);
  await Promise.all(state.servers.map(server => refreshRuntime(server, { deep, procs })));
}

function scheduleRuntimeRefresh({ deep = true } = {}) {
  if (runtimeRefreshPromise) return runtimeRefreshPromise;
  runtimeRefreshPromise = refreshAllRuntimes({ deep })
    .catch(err => console.error("[runtime refresh]", err))
    .finally(() => { runtimeRefreshPromise = null; });
  return runtimeRefreshPromise;
}

async function terminatePid(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
}

function runCaptured(command, args, timeoutMs = 30000) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: Number(code) || 0, output });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(1);
    }, timeoutMs);
    child.stdout.on("data", chunk => { output += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { output += chunk.toString("utf8"); });
    child.on("error", err => {
      output += err.message || "";
      finish(1);
    });
    child.on("close", code => finish(code));
  });
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function firewallRuleExists(ruleName) {
  const result = await runCaptured(
    "netsh",
    ["advfirewall", "firewall", "show", "rule", `name=${ruleName}`],
    10000
  );
  if (result.code !== 0) return false;
  return !/No rules match the specified criteria/i.test(result.output);
}

async function addFirewallRuleDirect(ruleName, protocol, port) {
  if (await firewallRuleExists(ruleName)) return true;
  const result = await runCaptured(
    "netsh",
    [
      "advfirewall", "firewall", "add", "rule",
      `name=${ruleName}`,
      "dir=in", "action=allow", `protocol=${protocol}`,
      `localport=${port}`
    ],
    15000
  );
  return result.code === 0 && (await firewallRuleExists(ruleName));
}

async function addFirewallRulesElevated(rules) {
  if (!rules.length) return true;
  const lines = rules.map(rule => {
    const name = powershellSingleQuote(rule.name);
    const port = Number(rule.port);
    return [
      `$n=${name}`,
      `$show = & netsh advfirewall firewall show rule name=$n 2>&1 | Out-String`,
      `if ($LASTEXITCODE -ne 0 -or $show -match 'No rules match') {`,
      `  & netsh advfirewall firewall add rule name=$n dir=in action=allow protocol=${rule.protocol} localport=${port} | Out-Null`,
      `  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `}`
    ].join("; ");
  });
  const elevatedScript = `$ErrorActionPreference = 'Stop'; ${lines.join("; ")}; exit 0`;
  const encodedScript = Buffer.from(elevatedScript, "utf16le").toString("base64");
  const launcher = [
    "$p = Start-Process -FilePath 'powershell.exe'",
    "-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','" + encodedScript + "')",
    "-Verb RunAs -WindowStyle Hidden -Wait -PassThru;",
    "if ($null -eq $p) { exit 1 }; exit $p.ExitCode"
  ].join(" ");
  const result = await runCaptured(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launcher],
    120000
  );
  if (result.code !== 0) return false;
  for (const rule of rules) {
    if (!(await firewallRuleExists(rule.name))) return false;
  }
  return true;
}

async function ensureManagerFirewallPort(port) {
  if (process.platform !== "win32") return;
  const ruleName = `Icarus Server Manager TCP ${port}`;
  if (await firewallRuleExists(ruleName)) return;
  if (await addFirewallRuleDirect(ruleName, "TCP", port)) {
    console.log(`Firewall rule added for manager TCP ${port}`);
    return;
  }
  console.log(`Requesting admin to open manager firewall port ${port} (TCP)...`);
  const ok = await addFirewallRulesElevated([{ name: ruleName, protocol: "TCP", port }]);
  if (ok) console.log(`Firewall rule added for manager TCP ${port}`);
  else console.warn(`Firewall rule for manager TCP ${port} was not added (UAC denied or failed)`);
}

async function ensureFirewall(server) {
  const mainPort = parseGamePort(server.launchArgs);
  if (!mainPort) {
    server.firewallStatus = "No Port";
    return server.firewallStatus;
  }
  const ports = [mainPort];
  const queryPort = parseQueryPort(server.launchArgs);
  if (queryPort) ports.push(queryPort);

  const rules = [];
  for (const port of [...new Set(ports)]) {
    for (const protocol of ["UDP", "TCP"]) {
      rules.push({
        name: `Icarus Server: ${server.profile} ${protocol} Port ${port}`,
        protocol,
        port
      });
    }
  }

  const missing = [];
  for (const rule of rules) {
    if (!(await addFirewallRuleDirect(rule.name, rule.protocol, rule.port))) {
      missing.push(rule);
    }
  }

  if (!missing.length) {
    server.firewallStatus = "Good";
    scheduleSave();
    return server.firewallStatus;
  }

  appendConsoleLog(
    server.id,
    "Firewall rules need administrator permission - approve the Windows UAC prompt…",
    "system"
  );
  addActivity(`Requesting admin to add firewall rules for ${server.profile}`, "info");

  const elevatedOk = await addFirewallRulesElevated(missing);
  server.firewallStatus = elevatedOk ? "Good" : "Needs Admin";
  scheduleSave();
  if (elevatedOk) {
    appendConsoleLog(server.id, "Firewall rules added successfully.", "system");
    addActivity(`Firewall rules added for ${server.profile}`, "success");
  } else {
    appendConsoleLog(
      server.id,
      "Firewall rules were not added (UAC denied or elevation failed). Server will still start.",
      "error"
    );
    addActivity(`Firewall needs admin for ${server.profile}`, "error");
  }
  return server.firewallStatus;
}

async function copyServerLogOnStop(server) {
  if (!server.install || !server.logLocation) return;
  const src = path.join(server.install, "Icarus", "Saved", "Logs", "Icarus.log");
  if (!(await pathExists(src))) return;
  const profile = server.profile.trim() || "Server";
  const destFolder = path.join(server.logLocation, profile, `${profile} Game Logs`);
  await mkdir(destFolder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
  const dest = path.join(destFolder, `${profile} Game Log ${stamp}.log`);
  await copyFile(src, dest);
}

async function startServer(server, { applyFirewall = false } = {}) {
  const runtime = runtimeOf(server.id);
  if (runtime.status === "running" || runtime.updating) {
    throw Object.assign(new Error("Server is already running or updating"), { status: 409 });
  }
  if (!server.install) throw Object.assign(new Error("Install location is not set"), { status: 400 });
  const exe = await resolveExePath(server);
  if (!(await pathExists(exe))) {
    throw Object.assign(new Error(`Server executable not found:\n${exe}`), { status: 404 });
  }
  const existing = await findProcessForInstall(server.install);
  if (existing) {
    runtime.status = "running";
    runtime.pid = existing.pid;
    runtime.startedAt = Date.now();
    runtime.availability = "Online";
    return publicServer(server);
  }

  server.launchArgs = applySteamServerName(server.launchArgs, server.profile);
  await ensureServerSettings(server);

  const shouldApplyFirewall = Boolean(server.firewallAutoApproved || applyFirewall);
  if (shouldApplyFirewall) {
    if (applyFirewall && !server.firewallAutoApproved) {
      server.firewallAutoApproved = true;
      scheduleSave();
    }
    await ensureFirewall(server);
  }

  const command = server.launchArgs
    ? `"${exe}" ${server.launchArgs}`
    : `"${exe}"`;
  const child = spawn(command, {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: true
  });
  child.unref();

  runtime.status = "running";
  runtime.pid = child.pid;
  runtime.startedAt = Date.now();
  runtime.availability = "Starting…";
  runtime.players = 0;
  runtime.maxPlayers = parseMaxPlayers(server.launchArgs);
  addActivity(`Started ${server.profile}`, "success");
  processCache.at = 0;
  appendConsoleLog(server.id, `Started ${server.profile}`, "system");
  ensureLogWatch(server).catch(() => {});
  ensureChatPoll(server).catch(() => {});

  setTimeout(async () => {
    try {
      const version = await getArkVersionFromLogs(server.install);
      if (version && version !== "Unknown") {
        server.version = version;
        scheduleSave();
      }
    } catch { /* ignore */ }
  }, 15000);

  return publicServer(server);
}

async function stopServer(server, { copyLog = true } = {}) {
  const runtime = runtimeOf(server.id);
  if (copyLog) {
    try { await copyServerLogOnStop(server); } catch (err) {
      addActivity(`Log copy failed for ${server.profile}: ${err.message}`, "error");
    }
  }

  const match = await findProcessForInstall(server.install);
  const pid = match?.pid || runtime.pid;
  if (pid) await terminatePid(pid);

  runtime.status = "stopped";
  runtime.pid = null;
  runtime.startedAt = 0;
  runtime.availability = "Offline";
  runtime.players = 0;
  addActivity(`Stopped ${server.profile}`, "info");
  processCache.at = 0;
  stopLogWatch(server.id);
  appendConsoleLog(server.id, "Server stopped.", "system");
  return publicServer(server);
}

async function downloadSteamCmd(destDir) {
  const target = destDir || path.join(os.homedir(), "Documents", "SteamCMD");
  await mkdir(target, { recursive: true });
  const zipPath = path.join(target, "steamcmd.zip");
  const res = await fetch(STEAMCMD_URL);
  if (!res.ok) throw new Error(`SteamCMD download failed (${res.status})`);
  await pipeline(res.body, createWriteStream(zipPath));

  if (process.platform === "win32") {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`],
      { windowsHide: true }
    );
  }
  await rm(zipPath, { force: true });
  const exe = path.join(target, "steamcmd.exe");
  if (await pathExists(exe)) {
    try {
      await execFileAsync(exe, ["+quit"], { cwd: target, windowsHide: true, timeout: 120000 });
    } catch { /* bootstrap may exit non-zero */ }
  }
  return target;
}

function appManifestCandidates(install) {
  return [
    path.join(install, "steamapps", `appmanifest_${STEAM_APP_ID}.acf`),
    path.join(install, "..", `appmanifest_${STEAM_APP_ID}.acf`),
    path.join(install, "..", "..", "steamapps", `appmanifest_${STEAM_APP_ID}.acf`)
  ];
}

async function clearStuckSteamState(server) {
  const removed = [];
  for (const file of appManifestCandidates(server.install)) {
    if (await pathExists(file)) {
      await rm(file, { force: true });
      removed.push(file);
      appendConsoleLog(server.id, `Removed stuck Steam manifest: ${file}`, "system");
    }
  }
  const downloading = path.join(server.install, "..", "downloading");
  if (await pathExists(downloading)) {
    try {
      await rm(downloading, { recursive: true, force: true });
      removed.push(downloading);
      appendConsoleLog(server.id, `Cleared steamapps/downloading cache`, "system");
    } catch (err) {
      appendConsoleLog(server.id, `Could not clear downloading folder: ${err.message}`, "error");
    }
  }
  return removed;
}

async function wipeInstallKeepSaved(server) {
  const install = server.install;
  if (!install || !(await pathExists(install))) {
    throw Object.assign(new Error("Install location is missing"), { status: 400 });
  }
  appendConsoleLog(server.id, "Repair mode: wiping server files but keeping Icarus\\Saved (worlds/configs)…", "system");
  const entries = await readdir(install, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(install, entry.name);
    if (entry.name.toLowerCase() === "icarus") {
      const inner = await readdir(full, { withFileTypes: true });
      for (const child of inner) {
        if (child.name.toLowerCase() === "saved") {
          appendConsoleLog(server.id, `Keeping ${path.join("Icarus", child.name)}`, "system");
          continue;
        }
        await rm(path.join(full, child.name), { recursive: true, force: true });
        appendConsoleLog(server.id, `Removed Icarus\\${child.name}`, "system");
      }
      continue;
    }
    await rm(full, { recursive: true, force: true });
    appendConsoleLog(server.id, `Removed ${entry.name}`, "system");
  }
  await clearStuckSteamState(server);
}

function spawnSteamCmdUpdate(server, steamcmdExe) {
  return new Promise(async (resolve) => {
    const args = [
      "+force_install_dir", server.install,
      "+login", "anonymous",
      "+app_update", STEAM_APP_ID, "validate",
      "+quit"
    ];
    appendConsoleLog(server.id, `> steamcmd ${args.join(" ")}`, "command");

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
    const profileClean = server.profile.replace(/[\\/]/g, "-");
    const logBase = server.updateLogLocation || server.install;
    const updateLogFolder = path.join(logBase, profileClean, `${server.profile} Update Logs`);
    await mkdir(updateLogFolder, { recursive: true });
    const logFile = path.join(updateLogFolder, `${server.profile} update log ${stamp}.log`);
    const logStream = createWriteStream(logFile, { flags: "a" });

    let output = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    const child = spawn(steamcmdExe, args, {
      cwd: path.dirname(steamcmdExe),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const flushLines = (raw, level, isFinal = false) => {
      const text = raw.toString("utf8");
      output += text;
      try { logStream.write(text); } catch { /* ignore */ }
      const combined = (level === "error" ? stderrBuf : stdoutBuf) + text;
      const parts = combined.split(/\r?\n|\r/);
      const remainder = isFinal ? "" : (parts.pop() || "");
      if (level === "error") stderrBuf = remainder;
      else stdoutBuf = remainder;
      for (const line of parts) {
        const cleaned = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (cleaned) appendConsoleLog(server.id, cleaned, level);
      }
      if (isFinal && remainder.trim()) {
        appendConsoleLog(server.id, remainder.replace(/\x1b\[[0-9;]*m/g, "").trim(), level);
      }
    };

    child.stdout.on("data", chunk => flushLines(chunk, "log"));
    child.stderr.on("data", chunk => flushLines(chunk, "error"));
    child.on("error", err => {
      try { logStream.end(); } catch { /* ignore */ }
      appendConsoleLog(server.id, `SteamCMD failed to start: ${err.message}`, "error");
      resolve({ code: 1, output, error: err.message });
    });
    child.on("close", code => {
      flushLines("", "log", true);
      flushLines("", "error", true);
      try { logStream.end(); } catch { /* ignore */ }
      resolve({ code: Number(code) || 0, output });
    });
  });
}

async function runSteamUpdate(server, { onComplete, repair = false } = {}) {
  const runtime = runtimeOf(server.id);
  const steamcmdExe = path.join(server.steamcmd, "steamcmd.exe");
  if (!(await pathExists(steamcmdExe))) {
    throw Object.assign(new Error("SteamCMD.exe was not found"), { status: 400 });
  }
  if (!server.install) {
    throw Object.assign(new Error("Install location is not set"), { status: 400 });
  }
  if (runtime.updating) {
    throw Object.assign(new Error("An update is already running for this server"), { status: 409 });
  }

  runtime.updating = true;
  runtime.status = "Updating";
  runtime.availability = "Offline";
  runtime.needsRepair = false;
  addActivity(`Updating ${server.profile} via SteamCMD`, "info");
  appendConsoleLog(server.id, `=== Update / Verify started for ${server.profile} ===`, "system");

  try {
    // SteamCMD 0x6 is often caused by locked files or a stuck appmanifest.
    const running = await findProcessForInstall(server.install);
    if (running) {
      appendConsoleLog(server.id, "Server is running — stopping it before update…", "system");
      await stopServer(server, { copyLog: false });
    }

    await mkdir(server.install, { recursive: true });

    if (repair) {
      await wipeInstallKeepSaved(server);
    }

    appendConsoleLog(server.id, "Bootstrapping SteamCMD…", "system");
    try {
      await execFileAsync(steamcmdExe, ["+quit"], {
        cwd: path.dirname(steamcmdExe),
        windowsHide: true,
        timeout: 120000
      });
    } catch {
      // bootstrap may exit non-zero
    }

    let result = await spawnSteamCmdUpdate(server, steamcmdExe);
    let hit06 = /state is 0x6/i.test(result.output);

    if (hit06 && !repair) {
      appendConsoleLog(server.id, "Detected SteamCMD 0x6 — clearing stuck manifest and retrying once…", "system");
      await clearStuckSteamState(server);
      result = await spawnSteamCmdUpdate(server, steamcmdExe);
      hit06 = /state is 0x6/i.test(result.output);
    }

    if (hit06) {
      runtime.needsRepair = true;
      appendConsoleLog(
        server.id,
        "SteamCMD 0x6 persisted. This usually means a corrupted install/manifest or content server issue. Use Repair & Redownload to wipe everything except Icarus\\Saved, then download fresh.",
        "error"
      );
      addActivity(`Update hit 0x6 for ${server.profile} — repair recommended`, "error");
    } else if (result.code === 0) {
      appendConsoleLog(server.id, "Update / Verify finished successfully.", "system");
      addActivity(`Update finished for ${server.profile}`, "success");
      try {
        const version = await getArkVersionFromLogs(server.install);
        if (version && version !== "Unknown") {
          server.version = version;
          scheduleSave();
        }
      } catch { /* ignore */ }
    } else {
      appendConsoleLog(server.id, `SteamCMD exited with code ${result.code}`, "error");
      addActivity(`Update finished with errors for ${server.profile}`, "error");
    }

    await refreshRuntime(server, { deep: true });
    const payload = { ...publicServer(server), needsRepair: Boolean(runtime.needsRepair), updateExitCode: result.code };
    if (typeof onComplete === "function" && !hit06 && result.code === 0) {
      try { await onComplete(); } catch (err) { addActivity(err.message, "error"); }
    }
    return payload;
  } finally {
    runtime.updating = false;
  }
}

async function zipDirectory(sourceDir, zipPath) {
  // Prefer PowerShell Compress-Archive for zero-deps zip create on Windows
  if (!(await pathExists(sourceDir))) throw new Error("Saved folder not found");
  await mkdir(path.dirname(zipPath), { recursive: true });
  if (await pathExists(zipPath)) await rm(zipPath, { force: true });
  await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ],
    { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
  );
}

async function pruneBackups(folder, limit) {
  const keep = clampInt(limit, 1, 100, 10);
  const entries = await readdir(folder);
  const zips = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".zip")) continue;
    const full = path.join(folder, name);
    const st = await stat(full);
    zips.push({ full, mtime: st.mtimeMs });
  }
  zips.sort((a, b) => b.mtime - a.mtime);
  for (const old of zips.slice(keep)) {
    await rm(old.full, { force: true });
  }
}

async function backupServer(server) {
  const runtime = runtimeOf(server.id);
  if (runtime.backupInProgress) throw Object.assign(new Error("Backup already in progress"), { status: 409 });
  if (!server.install) throw Object.assign(new Error("Install location is not set"), { status: 400 });
  const destRoot = server.autoBackupDest || server.install;
  if (!destRoot) throw Object.assign(new Error("Backup folder is not set"), { status: 400 });
  const profile = server.profile.trim() || "Server";
  const backupFolder = path.join(destRoot, `${profile} Backups`);
  await mkdir(backupFolder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
  const zipPath = path.join(backupFolder, `${profile}_${stamp}.zip`);
  runtime.backupInProgress = true;
  try {
    await zipDirectory(savedArksPath(server), zipPath);
    await pruneBackups(backupFolder, server.backupLimit);
    server.lastBackupAt = nowIso();
    scheduleSave();
    addActivity(`Backup created for ${server.profile}`, "success");
    return { zipPath, lastBackupAt: server.lastBackupAt };
  } finally {
    runtime.backupInProgress = false;
  }
}

async function openInEditor(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (!(await pathExists(filePath))) await writeFile(filePath, "", "utf8");
  if (process.platform === "win32") {
    const npp = path.join(process.env["ProgramFiles(x86)"] || "", "Notepad++", "notepad++.exe");
    const npp2 = path.join(process.env.ProgramFiles || "", "Notepad++", "notepad++.exe");
    const editor = (await pathExists(npp)) ? npp : (await pathExists(npp2)) ? npp2 : "notepad.exe";
    spawn(editor, [filePath], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return;
  }
  spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
}

async function copyConfigFiles(fromServer, toServer) {
  const pairs = [
    [settingsIniPath(fromServer), settingsIniPath(toServer)]
  ];
  for (const [src, dest] of pairs) {
    if (!(await pathExists(src))) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    if (await pathExists(dest)) {
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 15);
      await copyFile(dest, `${dest}.bak-${stamp}`);
    }
    await copyFile(src, dest);
  }
}

function copySettings(from, to, flags) {
  if (flags.launchArgs) to.launchArgs = from.launchArgs;
  if (flags.autoStart) {
    to.autostartDays = [...from.autostartDays];
    to.autostartTime = from.autostartTime;
    to.autostartUpdate = from.autostartUpdate;
  }
  if (flags.shutdown) {
    to.shutdownDays = [...from.shutdownDays];
    to.shutdownTime = from.shutdownTime;
    to.performUpdate = from.performUpdate;
    to.thenRestart = from.thenRestart;
  }
  if (flags.backup) {
    to.autoBackupEnabled = from.autoBackupEnabled;
    to.autoBackupInterval = from.autoBackupInterval;
    to.autoBackupDest = from.autoBackupDest;
    to.backupLimit = from.backupLimit;
  }
  if (flags.logs) {
    to.logLocation = from.logLocation;
    to.updateLogLocation = from.updateLogLocation;
  }
}

function timeMatchesMinute(hhmm) {
  const now = new Date();
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  return now.getHours() === h && now.getMinutes() === m;
}

function withinShutdownWindow(hhmm) {
  const now = new Date();
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(h, m, 0, 0);
  const diff = (now - scheduled) / 1000;
  return diff >= 0 && diff <= 120;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayIndexSunday0() {
  return new Date().getDay(); // 0=Sun
}

async function automationTick() {
  if (automationRunning) return;
  automationRunning = true;
  try {
    const dayIdx = dayIndexSunday0();
    const key = todayKey();
    for (const server of state.servers) {
      const runtime = runtimeOf(server.id);
      await refreshRuntime(server, { deep: false });

      // Auto start
      if (server.autostartDays[dayIdx] && timeMatchesMinute(server.autostartTime)) {
        if (runtime.autoStartTriggeredDate !== key && runtime.status === "stopped" && !runtime.updating) {
          runtime.autoStartTriggeredDate = key;
          try {
            if (server.autostartUpdate) {
              await runSteamUpdate(server, {
                onComplete: async () => {
                  await new Promise(r => setTimeout(r, 5000));
                  await startServer(server);
                }
              });
            } else {
              await startServer(server);
            }
          } catch (err) {
            addActivity(`Auto-start failed for ${server.profile}: ${err.message}`, "error");
          }
        }
      }

      // Shutdown / restart
      if (server.shutdownDays[dayIdx] && withinShutdownWindow(server.shutdownTime)) {
        if (runtime.shutdownTriggeredDate !== key && runtime.status === "running") {
          runtime.shutdownTriggeredDate = key;
          try {
            await stopServer(server);
            if (server.performUpdate) {
              await runSteamUpdate(server, {
                onComplete: server.thenRestart
                  ? async () => { await startServer(server); }
                  : undefined
              });
            } else if (server.thenRestart) {
              await startServer(server);
            }
          } catch (err) {
            addActivity(`Scheduled shutdown failed for ${server.profile}: ${err.message}`, "error");
          }
        }
      }

      // Auto backup
      if (server.autoBackupEnabled && server.autoBackupDest) {
        const minutes = BACKUP_INTERVALS[server.autoBackupInterval] || 30;
        const last = server.lastBackupAt ? Date.parse(server.lastBackupAt) : 0;
        if (!last) {
          server.lastBackupAt = nowIso();
          scheduleSave();
        } else if (Date.now() - last >= minutes * 60 * 1000 && !runtime.backupInProgress) {
          try {
            await backupServer(server);
          } catch (err) {
            addActivity(`Auto-backup failed for ${server.profile}: ${err.message}`, "error");
          }
        }
      }
    }
  } finally {
    automationRunning = false;
  }
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    if (rel !== "/index.html") {
      const index = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(index);
    }
    res.writeHead(404);
    res.end("Not found");
  }
}

async function handleApi(req, res, url) {
  const remote = req.socket.remoteAddress || "";
  if (!ALLOW_REMOTE && !isLoopbackRequest(req)) {
    return sendJson(res, 403, { error: "Remote access is disabled. Set ICARUS_ALLOW_REMOTE=true to enable." });
  }
  if (ALLOW_REMOTE && !ALLOW_PUBLIC && !isLoopbackRequest(req) && !isPrivateLanAddress(remote)) {
    return sendJson(res, 403, { error: "Only loopback/LAN clients are allowed. Set ICARUS_ALLOW_PUBLIC=true to allow all IPs." });
  }

  const { pathname } = url;
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/api/state") {
    await refreshAllRuntimes({ deep: false });
    scheduleRuntimeRefresh({ deep: true });
    return sendJson(res, 200, await publicStateAsync());
  }

  if (method === "POST" && pathname === "/api/servers") {
    const body = (await readBody(req)) || {};
    const server = makeServer({
      profile: body.profile || "New Server",
      order: state.servers.length
    });
    state.servers.push(server);
    scheduleSave();
    addActivity(`Created profile ${server.profile}`, "info");
    return sendJson(res, 201, publicServer(server));
  }

  if (method === "POST" && pathname === "/api/path/validate") {
    const body = (await readBody(req)) || {};
    const target = String(body.path || "").trim();
    if (!target) return sendJson(res, 400, { error: "path required" });
    const exists = await pathExists(target);
    let isDir = false;
    if (exists) {
      try { isDir = (await stat(target)).isDirectory(); } catch { /* ignore */ }
    }
    return sendJson(res, 200, { path: target, exists, isDir });
  }

  if (method === "POST" && pathname === "/api/steamcmd/download") {
    const body = (await readBody(req)) || {};
    const dest = await downloadSteamCmd(body.path || undefined);
    return sendJson(res, 200, { path: dest });
  }

  if (method === "POST" && pathname === "/api/servers/reorder") {
    const body = (await readBody(req)) || {};
    const ids = Array.isArray(body.ids) ? body.ids : [];
    ids.forEach((id, index) => {
      const server = getServer(id);
      if (server) server.order = index;
    });
    scheduleSave();
    return sendJson(res, 200, publicState());
  }

  if (method === "POST" && pathname === "/api/servers/copy-settings") {
    const body = (await readBody(req)) || {};
    const from = getServer(body.fromId);
    const to = getServer(body.toId);
    if (!from || !to) return sendJson(res, 404, { error: "Server not found" });
    if (from.id === to.id) return sendJson(res, 400, { error: "Source and target must differ" });
    copySettings(from, to, body.flags || {});
    if (body.flags?.configFiles) await copyConfigFiles(from, to);
    scheduleSave();
    addActivity(`Copied settings from ${from.profile} to ${to.profile}`, "success");
    return sendJson(res, 200, publicServer(to));
  }

  const match = pathname.match(/^\/api\/servers\/([^/]+)(?:\/(.+))?$/);
  if (!match) return sendJson(res, 404, { error: "Not found" });
  const server = getServer(match[1]);
  if (!server) return sendJson(res, 404, { error: "Server not found" });
  const action = match[2] || "";

  if (method === "GET" && !action) return sendJson(res, 200, publicServer(server));

  if (method === "PATCH" && !action) {
    const body = (await readBody(req)) || {};
    const fields = [
      "profile", "install", "steamcmd", "version", "launchArgs",
      "autostartTime", "autostartUpdate", "shutdownTime", "performUpdate", "thenRestart",
      "autoBackupEnabled", "autoBackupInterval", "autoBackupDest", "backupLimit",
      "logLocation", "updateLogLocation", "firewallStatus", "firewallAutoApproved"
    ];
    for (const key of fields) {
      if (body[key] !== undefined) server[key] = body[key];
    }
    if (body.autostartDays) server.autostartDays = normalizeDays(body.autostartDays);
    if (body.shutdownDays) server.shutdownDays = normalizeDays(body.shutdownDays);
    if (typeof server.profile === "string") server.profile = server.profile.trim() || "New Server";
    scheduleSave();
    return sendJson(res, 200, publicServer(server));
  }

  if (method === "DELETE" && !action) {
    if (state.servers.length <= 1) {
      return sendJson(res, 400, { error: "Cannot delete the last server profile" });
    }
    const runtime = runtimeOf(server.id);
    if (runtime.status === "running") await stopServer(server, { copyLog: false });
    state.servers = state.servers.filter(s => s.id !== server.id);
    state.servers.forEach((s, i) => { s.order = i; });
    runtimes.delete(server.id);
    scheduleSave();
    addActivity(`Deleted profile ${server.profile}`, "info");
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && action === "start") {
    const body = (await readBody(req)) || {};
    const result = await startServer(server, {
      applyFirewall: Boolean(body.applyFirewall)
    });
    return sendJson(res, 200, result);
  }
  if (method === "POST" && action === "stop") {
    const result = await stopServer(server);
    return sendJson(res, 200, result);
  }
  if (method === "POST" && action === "update") {
    const body = (await readBody(req)) || {};
    // Don't await full update (can take hours); kick off and stream to console
    runSteamUpdate(server, { repair: Boolean(body.repair) }).catch(err => {
      appendConsoleLog(server.id, `Update failed: ${err.message}`, "error");
      addActivity(`Update failed for ${server.profile}: ${err.message}`, "error");
      const runtime = runtimeOf(server.id);
      runtime.updating = false;
    });
    return sendJson(res, 202, publicServer(server));
  }
  if (method === "POST" && action === "backup") {
    const result = await backupServer(server);
    return sendJson(res, 200, { ...publicServer(server), ...result });
  }
  if (method === "POST" && action === "firewall") {
    const status = await ensureFirewall(server);
    if (!server.firewallAutoApproved) {
      server.firewallAutoApproved = true;
      scheduleSave();
    }
    return sendJson(res, 200, { ...publicServer(server), firewallStatus: status });
  }
  if (method === "POST" && action === "open-ini") {
    await readBody(req).catch(() => null);
    const filePath = settingsIniPath(server);
    if (!server.install) return sendJson(res, 400, { error: "Install location is not set" });
    await openInEditor(filePath);
    return sendJson(res, 200, { ok: true, path: filePath });
  }
  if (method === "POST" && action === "refresh-version") {
    const version = await getArkVersionFromLogs(server.install);
    if (version && version !== "Unknown") {
      server.version = version;
      scheduleSave();
    }
    return sendJson(res, 200, publicServer(server));
  }

  if (method === "GET" && action === "console") {
    const runtime = runtimeOf(server.id);
    const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
    return sendJson(res, 200, {
      logs: runtime.consoleLogs.filter(l => l.id > since),
      rcon: await getRconPublic(server)
    });
  }

  if (method === "GET" && action === "console-stream") {
    openConsoleStream(req, res, server);
    return;
  }

  if (method === "POST" && action === "command") {
    const body = (await readBody(req)) || {};
    let command = String(body.command || "").trim();
    const asChat = Boolean(body.asChat);
    if (!command) return sendJson(res, 400, { error: "Command is required" });
    if (asChat) command = `ServerChat ${command}`;

    if (String(runtimeOf(server.id).status).toLowerCase() !== "running") {
      return sendJson(res, 409, { error: "Server must be running" });
    }
    appendConsoleLog(server.id, `> ${command}`, "command");
    appendConsoleLog(
      server.id,
      "Icarus admin commands are in-game: /AdminLogin <AdminPassword>, /AdminSay, /KickPlayer, /BanPlayer, /ReturnToLobby.",
      "system"
    );
    return sendJson(res, 200, {
      ok: false,
      reply: "Icarus does not expose Source RCON. Use in-game /AdminLogin with AdminPassword from ServerSettings.ini."
    });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: err.message || "Server error" });
  }
}

async function main() {
  await loadState();
  for (const server of state.servers) runtimeOf(server.id);
  await refreshAllRuntimes({ deep: false });
  scheduleRuntimeRefresh({ deep: true });

  setInterval(() => {
    scheduleRuntimeRefresh({ deep: true });
  }, 8000);

  setInterval(() => {
    automationTick().catch(err => console.error("[automation]", err));
  }, 60000);

  const server = http.createServer((req, res) => {
    handler(req, res);
  });

  server.on("error", err => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Close the other Icarus Manager window, or run Start Icarus Manager.cmd again (it now stops the old process).`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const localUrl = `http://127.0.0.1:${PORT}`;
    const lans = lanAddresses();
    console.log(`Icarus Server Manager listening on ${HOST}:${PORT}`);
    console.log(`  Port:   ${PORT}`);
    console.log(`  Local:  ${localUrl}`);
    for (const ip of lans) console.log(`  Network: http://${ip}:${PORT}`);
    if (!lans.length) console.log(`  Network: http://<this-pc-ip>:${PORT}`);
    ensureManagerFirewallPort(PORT).catch(err => {
      console.warn(`[firewall] Could not ensure manager port ${PORT}: ${err.message}`);
    });
    if (!process.argv.includes("--no-open") && process.platform === "win32") {
      const openUrl = lans[0] ? `http://${lans[0]}:${PORT}` : localUrl;
      spawn("cmd", ["/c", "start", "", openUrl], { detached: true, stdio: "ignore" }).unref();
    }
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
