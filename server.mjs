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
const MAX_IMPORT_COPY_BYTES = 20 * 1024 * 1024 * 1024;
const STEAM_APP_ID = "2089300";
const STEAMCMD_URL = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";
const EXE_NAME = "IcarusServer-Win64-Shipping.exe";
const EXE_NAMES = ["IcarusServer.exe", EXE_NAME];
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
const importJobs = new Map();
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
    exe: String(partial.exe || "").trim(),
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
    order: Number.isFinite(Number(partial.order)) ? Number(partial.order) : 0,
    icarus: makeIcarus({
      ...(partial.icarus || {}),
      gamePort: partial.icarus?.gamePort ?? parseGamePort(partial.launchArgs ?? partial.launch_args),
      queryPort: partial.icarus?.queryPort ?? parseQueryPort(partial.launchArgs ?? partial.launch_args)
    })
  };
}

function makeIcarus(partial = {}) {
  const mode = String(partial.prospectMode || "resume").toLowerCase();
  return {
    joinPassword: String(partial.joinPassword ?? ""),
    adminPassword: String(partial.adminPassword ?? ""),
    maxPlayers: clampInt(partial.maxPlayers ?? 8, 1, 20, 8),
    stayOnline: partial.stayOnline !== undefined ? Boolean(partial.stayOnline) : true,
    prospectMode: ["resume", "load", "create", "lobby"].includes(mode) ? mode : "resume",
    loadProspect: String(partial.loadProspect ?? "").trim(),
    createType: String(partial.createType ?? "OpenWorld_Styx").trim() || "OpenWorld_Styx",
    createDifficulty: String(partial.createDifficulty ?? "2"),
    createHardcore: Boolean(partial.createHardcore),
    createSave: String(partial.createSave ?? "").trim(),
    allowNonAdminsLaunch: partial.allowNonAdminsLaunch !== undefined ? Boolean(partial.allowNonAdminsLaunch) : true,
    allowNonAdminsDelete: Boolean(partial.allowNonAdminsDelete),
    gamePort: clampInt(partial.gamePort ?? 17777, 1024, 65535, 17777),
    queryPort: clampInt(partial.queryPort ?? 27015, 1024, 65535, 27015),
    lastProspectName: String(partial.lastProspectName ?? "").trim()
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
      playerNames: [],
      playersOnline: [],
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

function parseMaxPlayers(serverOrArgs) {
  if (serverOrArgs && typeof serverOrArgs === "object") {
    return clampInt(serverOrArgs.icarus?.maxPlayers, 1, 20, 8);
  }
  const text = String(serverOrArgs || "");
  let match = text.match(/-MaxPlayers=(\d+)/i);
  if (match) return Number(match[1]);
  match = text.match(/MaxPlayers=(\d+)/i);
  return match ? Number(match[1]) : 8;
}

function exeCandidates(server) {
  const install = server.install || "";
  const attached = String(server.exe || "").trim();
  const names = EXE_NAMES;
  const dirs = [
    install,
    path.join(install, "Icarus"),
    path.join(install, "Icarus", "Binaries", "Win64"),
    path.join(install, "Binaries", "Win64")
  ];
  const out = [];
  if (attached) out.push(attached);
  for (const dir of dirs) {
    for (const name of names) out.push(path.join(dir, name));
  }
  return [...new Set(out)];
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

function installRootFromExe(exePath) {
  let dir = path.dirname(path.resolve(exePath));
  if (/[\\/]Binaries[\\/]Win64$/i.test(dir)) {
    const icarusDir = path.dirname(path.dirname(dir));
    if (path.basename(icarusDir).toLowerCase() === "icarus") {
      return path.dirname(icarusDir);
    }
    return icarusDir;
  }
  if (path.basename(dir).toLowerCase() === "icarus") return path.dirname(dir);
  return dir;
}

async function attachToIcarusInstall(input) {
  const target = path.resolve(String(input || "").trim());
  if (!target) throw Object.assign(new Error("Choose the Icarus install folder or IcarusServer.exe"), { status: 400 });
  if (!(await pathExists(target))) throw Object.assign(new Error("That path does not exist"), { status: 404 });
  const st = await stat(target);
  if (st.isFile()) {
    const base = path.basename(target);
    if (!/^IcarusServer/i.test(base) || !/\.exe$/i.test(base)) {
      throw Object.assign(new Error("Attach to IcarusServer.exe (or IcarusServer-Win64-Shipping.exe)"), { status: 400 });
    }
    const install = installRootFromExe(target);
    return { install, exe: target };
  }
  const install = await resolveIcarusInstallRoot(target);
  const exe = await resolveExePath({ install, exe: "" });
  if (!(await pathExists(exe))) {
    throw Object.assign(new Error("Could not find IcarusServer.exe in that folder"), { status: 400 });
  }
  return { install, exe };
}

function windowsServerConfigDir(server) {
  return path.join(server.install || "", "Icarus", "Saved", "Config", "WindowsServer");
}

function settingsIniPath(server) {
  return path.join(windowsServerConfigDir(server), "ServerSettings.ini");
}

const KNOWN_CONFIG_FILES = [
  "ServerSettings.ini",
  "Engine.ini",
  "Game.ini",
  "GameUserSettings.ini",
  "Scalability.ini",
  "Input.ini",
  "DeviceProfiles.ini",
  "Admins.txt"
];

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

function configFileTemplate(name) {
  const key = String(name || "").toLowerCase();
  if (key === "serversettings.ini") return DEFAULT_SERVER_SETTINGS;
  if (key === "engine.ini") return "[Core.System]\n";
  if (key === "game.ini") return "[/Script/Engine.GameSession]\n";
  if (key === "gameusersettings.ini") return "[/Script/Engine.GameUserSettings]\n";
  if (key === "scalability.ini") return "[ScalabilitySettings]\n";
  if (key === "input.ini") return "[/Script/Engine.InputSettings]\n";
  if (key === "deviceprofiles.ini") return "[DeviceProfiles]\n";
  if (key === "admins.txt") return "; Optional SteamID64 list, one per line. In-game admin still uses /AdminLogin.\n";
  return "";
}

function safeConfigFileName(name) {
  const base = path.basename(String(name || "").trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(ini|txt|cfg)$/i.test(base)) return "";
  return base;
}

function configFilePath(server, name) {
  const safe = safeConfigFileName(name);
  if (!safe || !server.install) return "";
  const dir = path.resolve(windowsServerConfigDir(server));
  const full = path.resolve(dir, safe);
  if (!isPathInside(dir, full)) return "";
  return full;
}

async function listConfigFiles(server) {
  const folder = windowsServerConfigDir(server);
  const present = new Map();
  if (await pathExists(folder)) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const safe = safeConfigFileName(entry.name);
      if (!safe) continue;
      const full = path.join(folder, entry.name);
      const st = await stat(full);
      present.set(safe.toLowerCase(), {
        name: entry.name,
        exists: true,
        bytes: st.size,
        sizeLabel: formatBytes(st.size),
        modified: st.mtime.toISOString()
      });
    }
  }
  const files = [];
  const seen = new Set();
  for (const name of KNOWN_CONFIG_FILES) {
    const found = present.get(name.toLowerCase());
    seen.add(name.toLowerCase());
    files.push(found || { name, exists: false, bytes: 0, sizeLabel: "", modified: null });
  }
  for (const file of present.values()) {
    if (seen.has(file.name.toLowerCase())) continue;
    files.push(file);
  }
  return { folder, files };
}

async function addConfigFile(server, { name, content, source } = {}) {
  const filePath = configFilePath(server, name);
  if (!filePath) throw Object.assign(new Error("Use a simple .ini, .txt, or .cfg filename"), { status: 400 });
  if (!server.install) throw Object.assign(new Error("Install location is not set"), { status: 400 });
  await mkdir(path.dirname(filePath), { recursive: true });
  const from = String(source || "").trim();
  if (from) {
    if (!(await pathExists(from))) throw Object.assign(new Error("Source file was not found"), { status: 404 });
    const st = await stat(from);
    if (!st.isFile()) throw Object.assign(new Error("Source path must be a file"), { status: 400 });
    if (st.size > 1024 * 1024) throw Object.assign(new Error("Config files are limited to 1 MB"), { status: 400 });
    await copyFile(from, filePath);
  } else if (content != null && String(content).length) {
    const text = String(content);
    if (Buffer.byteLength(text) > 1024 * 1024) throw Object.assign(new Error("Config files are limited to 1 MB"), { status: 400 });
    await writeFile(filePath, text, "utf8");
  } else if (safeConfigFileName(name).toLowerCase() === "serversettings.ini") {
    await writeIcarusSettings(server);
  } else {
    await writeFile(filePath, configFileTemplate(name), "utf8");
  }
  return filePath;
}

async function deleteConfigFile(server, name) {
  const filePath = configFilePath(server, name);
  if (!filePath) throw Object.assign(new Error("Invalid config filename"), { status: 400 });
  if (!(await pathExists(filePath))) throw Object.assign(new Error("File is not on disk"), { status: 404 });
  await rm(filePath, { force: true });
  return filePath;
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

function applyLaunchFlag(launchArgs, flag, value, { quoted = false } = {}) {
  const args = String(launchArgs || "").trim();
  const next = quoted ? `${flag}="${String(value).replace(/"/g, "")}"` : `${flag}=${value}`;
  const pattern = new RegExp(`${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(?:"[^"]*"|\\S+)`, "i");
  if (pattern.test(args)) return args.replace(pattern, next);
  return `${args} ${next}`.trim();
}

function applyIcarusLaunchArgs(server) {
  const icarus = makeIcarus(server.icarus);
  server.icarus = icarus;
  let args = applySteamServerName(server.launchArgs, server.profile);
  args = applyLaunchFlag(args, "-Port", icarus.gamePort);
  args = applyLaunchFlag(args, "-QueryPort", icarus.queryPort);
  args = String(args || "").replace(/(?:^|\s)-MULTIHOME=(?:127\.0\.0\.1|localhost|\[?::1\]?)(?=\s|$)/ig, " ").replace(/\s+/g, " ").trim();
  if (!/(?:^|\s)-Log(?:\s|$)/i.test(args)) args = `${args} -Log`.trim();
  server.launchArgs = args;
  return args;
}

function iniBool(value) {
  return value ? "True" : "False";
}

function readIniValue(raw, key) {
  const match = String(raw || "").match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "im"));
  return match ? String(match[1]).trim() : "";
}

function upsertIniValue(raw, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}\\s*=.*$`, "im");
  if (pattern.test(raw)) return raw.replace(pattern, line);
  const header = "[/Script/Icarus.DedicatedServerSettings]";
  if (raw.includes(header)) return raw.replace(header, `${header}\n${line}`);
  return `${header}\n${line}\n${raw}`;
}

function createProspectLine(icarus) {
  const type = String(icarus.createType || "").trim();
  const save = String(icarus.createSave || "").trim();
  if (!type || !save) return "";
  const difficulty = clampInt(icarus.createDifficulty, 1, 4, 2);
  const hardcore = icarus.createHardcore ? "true" : "false";
  return `${type} ${difficulty} ${hardcore} ${save}`;
}

async function writeIcarusSettings(server) {
  const icarus = makeIcarus(server.icarus);
  server.icarus = icarus;
  const iniPath = settingsIniPath(server);
  await mkdir(path.dirname(iniPath), { recursive: true });
  let raw = (await pathExists(iniPath)) ? await readFile(iniPath, "utf8") : DEFAULT_SERVER_SETTINGS;
  const shutdown = icarus.stayOnline ? "-1" : "300.000000";
  const load = icarus.prospectMode === "load" ? icarus.loadProspect : "";
  const create = icarus.prospectMode === "create" ? createProspectLine(icarus) : "";
  const resume = icarus.prospectMode === "resume";
  const updates = {
    SessionName: "",
    JoinPassword: icarus.joinPassword,
    MaxPlayers: String(icarus.maxPlayers),
    AdminPassword: icarus.adminPassword,
    ShutdownIfNotJoinedFor: shutdown,
    ShutdownIfEmptyFor: shutdown,
    AllowNonAdminsToLaunchProspects: iniBool(icarus.allowNonAdminsLaunch),
    AllowNonAdminsToDeleteProspects: iniBool(icarus.allowNonAdminsDelete),
    LoadProspect: load,
    CreateProspect: create,
    ResumeProspect: iniBool(resume)
  };
  for (const [key, value] of Object.entries(updates)) {
    raw = upsertIniValue(raw, key, value);
  }
  await writeFile(iniPath, raw.replace(/\n{3,}/g, "\n\n"), "utf8");
}

async function hydrateIcarusFromIni(server) {
  try {
    const iniPath = settingsIniPath(server);
    if (!server.install || !(await pathExists(iniPath))) return;
    const raw = await readFile(iniPath, "utf8");
    const last = readIniValue(raw, "LastProspectName");
    if (last) server.icarus.lastProspectName = last;
    if (!server.icarus.joinPassword) server.icarus.joinPassword = readIniValue(raw, "JoinPassword");
    if (!server.icarus.adminPassword) server.icarus.adminPassword = readIniValue(raw, "AdminPassword");
  } catch {
    // ignore missing/unreadable ini
  }
}

async function ensureServerSettings(server) {
  await writeIcarusSettings(server);
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
    "Cache-Control": "no-store",
    ...corsHeaders()
  });
  res.end(data);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    "Access-Control-Max-Age": "86400"
  };
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
    id, profile, install, exe, steamcmd, version, launchArgs,
    autostartDays, autostartTime, autostartUpdate,
    shutdownDays, shutdownTime, performUpdate, thenRestart,
    autoBackupEnabled, autoBackupInterval, autoBackupDest, backupLimit,
    logLocation, updateLogLocation, firewallStatus, firewallAutoApproved, lastBackupAt, order, icarus
  } = server;
  return {
    id, profile, install, exe, steamcmd, version, launchArgs,
    autostartDays, autostartTime, autostartUpdate,
    shutdownDays, shutdownTime, performUpdate, thenRestart,
    autoBackupEnabled, autoBackupInterval, autoBackupDest, backupLimit,
    logLocation, updateLogLocation, firewallStatus, firewallAutoApproved, lastBackupAt, order,
    icarus: makeIcarus(icarus),
    status: runtime.updating ? "Updating" : runtime.status,
    availability: runtime.availability,
    players: runtime.players,
    playerNames: Array.isArray(runtime.playerNames) ? runtime.playerNames : [],
    playersOnline: Array.isArray(runtime.playersOnline) ? runtime.playersOnline : [],
    maxPlayers: runtime.maxPlayers || parseMaxPlayers(server),
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
  const servers = await Promise.all(ordered.map(async server => {
    await hydrateIcarusFromIni(server);
    return publicServer(server, await getRconPublic(server));
  }));
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

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = "B";
  for (const next of units) {
    value /= 1024;
    unit = next;
    if (value < 1024) break;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function isPathInside(parent, child) {
  const a = path.resolve(parent).toLowerCase();
  const b = path.resolve(child).toLowerCase();
  if (b === a) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(prefix.toLowerCase());
}

function parseIniBool(value, fallback = false) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return fallback;
}

function parseCreateProspect(line) {
  const parts = String(line || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { createType: "OpenWorld_Styx", createDifficulty: "2", createHardcore: false, createSave: "" };
  }
  return {
    createType: parts[0] || "OpenWorld_Styx",
    createDifficulty: String(clampInt(parts[1], 1, 4, 2)),
    createHardcore: parseIniBool(parts[2], false),
    createSave: parts.slice(3).join(" ")
  };
}

function icarusFromIniText(raw, launchArgs = "") {
  const load = readIniValue(raw, "LoadProspect");
  const create = readIniValue(raw, "CreateProspect");
  const resume = parseIniBool(readIniValue(raw, "ResumeProspect"), true);
  let prospectMode = "resume";
  if (load) prospectMode = "load";
  else if (resume) prospectMode = "resume";
  else if (create) prospectMode = "create";
  else prospectMode = "lobby";
  const created = parseCreateProspect(create);
  const shutdown = String(readIniValue(raw, "ShutdownIfNotJoinedFor") || "").trim();
  const stayOnline = shutdown === "-1" || shutdown === "";
  return makeIcarus({
    joinPassword: readIniValue(raw, "JoinPassword"),
    adminPassword: readIniValue(raw, "AdminPassword"),
    maxPlayers: clampInt(readIniValue(raw, "MaxPlayers") || 8, 1, 20, 8),
    stayOnline,
    prospectMode,
    loadProspect: load,
    ...created,
    allowNonAdminsLaunch: parseIniBool(readIniValue(raw, "AllowNonAdminsToLaunchProspects"), true),
    allowNonAdminsDelete: parseIniBool(readIniValue(raw, "AllowNonAdminsToDeleteProspects"), false),
    lastProspectName: readIniValue(raw, "LastProspectName"),
    gamePort: parseGamePort(launchArgs),
    queryPort: parseQueryPort(launchArgs)
  });
}

async function findSettingsIniForInstall(install) {
  const candidates = [
    path.join(install, "Icarus", "Saved", "Config", "WindowsServer", "ServerSettings.ini"),
    path.join(install, "Icarus", "Saved", "Config", "ServerSettings.ini"),
    path.join(install, "Saved", "Config", "WindowsServer", "ServerSettings.ini")
  ];
  for (const file of candidates) {
    if (await pathExists(file)) return file;
  }
  return candidates[0];
}

async function resolveIcarusInstallRoot(input) {
  let dir = path.resolve(String(input || "").trim());
  if (!dir) throw Object.assign(new Error("Choose a server folder"), { status: 400 });
  if (!(await pathExists(dir))) throw Object.assign(new Error("That folder does not exist"), { status: 404 });
  const st = await stat(dir);
  if (st.isFile()) dir = path.dirname(dir);
  let current = dir;
  for (let i = 0; i < 8; i++) {
    const fake = { install: current };
    for (const candidate of exeCandidates(fake)) {
      if (await pathExists(candidate)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw Object.assign(new Error("That folder does not look like an Icarus server (missing IcarusServer.exe)"), { status: 400 });
}

async function readLaunchHints(install) {
  let args = "";
  let names = [];
  try {
    const entries = await readdir(install);
    for (const name of entries) {
      if (!/\.(bat|cmd|ps1|txt)$/i.test(name)) continue;
      const full = path.join(install, name);
      try {
        const st = await stat(full);
        if (!st.isFile() || st.size > 256 * 1024) continue;
        const text = await readFile(full, "utf8");
        if (/-SteamServerName=/i.test(text) || /-Port=/i.test(text) || /IcarusServer/i.test(text)) {
          args += ` ${text}`;
        }
        const named = text.match(/-SteamServerName=(?:"([^"]+)"|(\S+))/i);
        if (named) names.push(named[1] || named[2]);
      } catch { /* skip unreadable */ }
    }
  } catch { /* ignore */ }
  return { launchText: args, scriptName: names.find(Boolean) || "" };
}

async function findSteamCmdNear(install) {
  const dirs = [
    path.join(install, "SteamCMD"),
    path.join(install, "steamcmd"),
    path.join(path.dirname(install), "SteamCMD"),
    path.join(path.dirname(install), "steamcmd"),
    install,
    path.dirname(install)
  ];
  for (const dir of dirs) {
    if (await pathExists(path.join(dir, "steamcmd.exe"))) return dir;
  }
  return "";
}

async function measureFolder(root) {
  let bytes = 0;
  let files = 0;
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          bytes += (await stat(full)).size;
          files += 1;
        } catch { /* skip */ }
      }
    }
  }
  await walk(root);
  return { bytes, files };
}

async function inspectIcarusInstall(sourcePath, { measure = true } = {}) {
  const install = await resolveIcarusInstallRoot(sourcePath);
  const iniPath = await findSettingsIniForInstall(install);
  const raw = (await pathExists(iniPath)) ? await readFile(iniPath, "utf8") : "";
  const hints = await readLaunchHints(install);
  const icarus = icarusFromIniText(raw, hints.launchText || defaultLaunchArgs(path.basename(install)));
  const profile = String(
    hints.scriptName || icarus.lastProspectName || path.basename(install) || "Imported Server"
  ).replace(/"/g, "").trim() || "Imported Server";
  let launchArgs = defaultLaunchArgs(profile);
  launchArgs = applyLaunchFlag(launchArgs, "-Port", icarus.gamePort);
  launchArgs = applyLaunchFlag(launchArgs, "-QueryPort", icarus.queryPort);
  const size = measure ? await measureFolder(install) : { bytes: 0, files: 0 };
  const steamcmd = await findSteamCmdNear(install);
  let version = "";
  try {
    const found = await getArkVersionFromLogs(install);
    if (found && found !== "Unknown") version = found;
  } catch { /* ignore */ }
  return {
    source: install,
    profile,
    install,
    steamcmd,
    version,
    launchArgs,
    icarus,
    iniPath: (await pathExists(iniPath)) ? iniPath : "",
    hasSettings: Boolean(raw),
    bytes: size.bytes,
    files: size.files,
    sizeLabel: formatBytes(size.bytes),
    copyAllowed: size.bytes <= MAX_IMPORT_COPY_BYTES
  };
}

async function copyInstallTree(src, dest, job) {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory());
  const files = entries.filter(entry => entry.isFile());
  for (const entry of dirs) {
    if (job.cancel) throw Object.assign(new Error("Import cancelled"), { status: 400 });
    await copyInstallTree(path.join(src, entry.name), path.join(dest, entry.name), job);
  }
  let index = 0;
  const workers = Math.min(8, Math.max(1, files.length));
  async function worker() {
    while (index < files.length) {
      if (job.cancel) throw Object.assign(new Error("Import cancelled"), { status: 400 });
      const entry = files[index++];
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      await copyFile(from, to);
      try {
        job.copiedBytes += (await stat(from)).size;
      } catch { /* size already counted in inspect */ }
      job.copiedFiles += 1;
    }
  }
  if (files.length) await Promise.all(Array.from({ length: workers }, () => worker()));
}

function publicImportJob(job) {
  const percent = job.totalBytes
    ? Math.min(99, Math.floor((job.copiedBytes / job.totalBytes) * 100))
    : (job.status === "done" ? 100 : 0);
  return {
    id: job.id,
    status: job.status,
    error: job.error || "",
    copy: job.copy,
    source: job.source,
    dest: job.dest,
    copiedBytes: job.copiedBytes,
    copiedFiles: job.copiedFiles,
    totalBytes: job.totalBytes,
    totalFiles: job.totalFiles,
    percent: job.status === "done" ? 100 : percent,
    sizeLabel: formatBytes(job.copiedBytes),
    totalLabel: formatBytes(job.totalBytes),
    server: job.server || null
  };
}

async function runImportJob(job) {
  job.status = job.copy ? "copying" : "importing";
  try {
    const install = job.copy ? job.dest : job.source;
    if (job.copy) {
      if (path.resolve(job.source).toLowerCase() === path.resolve(job.dest).toLowerCase()) {
        throw Object.assign(new Error("Copy destination must be different from the source folder"), { status: 400 });
      }
      if (isPathInside(job.source, job.dest)) {
        throw Object.assign(new Error("Copy destination cannot be inside the source folder"), { status: 400 });
      }
      if (await pathExists(job.dest)) {
        const destStat = await stat(job.dest);
        if (!destStat.isDirectory()) {
          throw Object.assign(new Error("Copy destination must be a folder"), { status: 400 });
        }
        const existing = await readdir(job.dest);
        if (existing.length) {
          throw Object.assign(new Error("Copy destination must be empty or a new folder"), { status: 400 });
        }
      }
      await copyInstallTree(job.source, job.dest, job);
    }
    const preview = await inspectIcarusInstall(install, { measure: false });
    const attached = await attachToIcarusInstall(install);
    await ensureModsFolder({ install: attached.install }).catch(() => {});
    const server = makeServer({
      profile: job.profile || preview.profile,
      install: attached.install,
      exe: attached.exe,
      steamcmd: preview.steamcmd,
      version: preview.version,
      launchArgs: preview.launchArgs,
      icarus: preview.icarus,
      order: state.servers.length
    });
    server.icarus = makeIcarus(preview.icarus);
    server.launchArgs = applyIcarusLaunchArgs(server);
    state.servers.push(server);
    scheduleSave();
    addActivity(`Imported ${server.profile} from ${install}`, "success");
    job.server = publicServer(server);
    job.status = "done";
    job.copiedBytes = job.totalBytes || job.copiedBytes;
  } catch (err) {
    job.status = "error";
    job.error = err.message || "Import failed";
  }
}

async function browseFolderDialog(title) {
  if (process.platform !== "win32") {
    throw Object.assign(new Error("Folder picker is only available on Windows. Paste the path instead."), { status: 400 });
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$dialog.Description = ${powershellSingleQuote(title || "Select folder")}`,
    "$dialog.ShowNewFolderButton = $true",
    "try { $dialog.UseDescriptionForTitle = $true } catch {}",
    "[void][System.Windows.Forms.Application]::EnableVisualStyles()",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
  ].join("; ");
  const result = await runCaptured("powershell.exe", ["-NoProfile", "-STA", "-Command", script], 300000);
  const selected = String(result.output || "").trim();
  return { path: selected, cancelled: !selected };
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
        const text = decodeLogBuffer(buf);
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
    "X-Accel-Buffering": "no",
    ...corsHeaders()
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

function decodeLogBuffer(buf) {
  if (!buf || !buf.length) return "";
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return buf.subarray(2).swap16().toString("utf16le");
  }
  let nulls = 0;
  const sample = Math.min(buf.length, 240);
  for (let i = 0; i < sample; i++) if (buf[i] === 0) nulls += 1;
  if (nulls > sample / 5) return buf.toString("utf16le");
  return buf.toString("utf8");
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

function readWideCString(buf, offset) {
  let end = offset;
  while (end + 1 < buf.length && (buf[end] !== 0 || buf[end + 1] !== 0)) end += 2;
  return [buf.toString("utf16le", offset, end).replace(/\u0000/g, "").trim(), end + 2];
}

function parseA2sPlayerList(msg) {
  if (!msg || msg.length < 6) return [];
  let payload = msg;
  if (msg[0] === 0xFF && msg[4] === 0x44) payload = msg.subarray(4);
  else if (msg[0] !== 0x44) return [];
  const tryParse = (skipIndex, wide) => {
    let offset = 1;
    const count = payload[offset++];
    if (!Number.isFinite(count) || count > 64) return { names: [], count: 0 };
    const names = [];
    for (let i = 0; i < count && offset < payload.length; i++) {
      if (skipIndex) {
        if (offset >= payload.length) break;
        offset += 1;
      }
      let name;
      [name, offset] = wide ? readWideCString(payload, offset) : readCString(payload, offset);
      if (offset + 8 > payload.length) break;
      const score = payload.readInt32LE(offset);
      offset += 8;
      const cleaned = String(name || "").trim();
      if (!isJunkPlayerName(cleaned)) names.push({ name: cleaned, ping: pingFromA2sScore(score) });
    }
    return { names, count };
  };
  const indexed = tryParse(true, false);
  if (indexed.names.length) return indexed.names;
  const indexedWide = tryParse(true, true);
  if (indexedWide.names.length) return indexedWide.names;
  return [];
}

function queryA2sPlayers(host, port, timeoutMs = 1200) {
  return new Promise(resolve => {
    const sock = dgram.createSocket("udp4");
    const challengeReq = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55, 0xFF, 0xFF, 0xFF, 0xFF]);
    const chunks = new Map();
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
          sock.send(Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55]),
            msg.subarray(5, 9)
          ]), port, host);
          return;
        }
        if (msg.length >= 9 && msg[0] === 0xFE) {
          const total = msg[8];
          const number = msg[9];
          const body = msg.subarray(10);
          chunks.set(number, body);
          if (chunks.size >= total && total > 0) {
            const ordered = [];
            for (let i = 0; i < total; i++) {
              if (!chunks.has(i)) return;
              ordered.push(chunks.get(i));
            }
            finish(parseA2sPlayerList(Buffer.concat(ordered)));
          }
          return;
        }
        if (msg.length < 6 || msg[4] !== 0x44) return;
        finish(parseA2sPlayerList(msg));
      } catch {
        // keep waiting until timeout
      }
    });
    sock.on("error", () => finish(null));
    sock.send(challengeReq, port, host, err => {
      if (err) finish(null);
    });
  });
}

async function queryLocalA2sPlayers(port) {
  const hosts = ["127.0.0.1"];
  const lan = lanAddresses();
  if (lan[0]) hosts.push(lan[0]);
  const seen = new Set();
  for (const host of hosts) {
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const names = await queryA2sPlayers(host, port, 1200);
    if (Array.isArray(names) && names.length) return names;
  }
  return null;
}

function jsonStringValue(raw) {
  if (!raw) return "";
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return String(raw).replace(/\\"/g, "\"");
  }
}

function parseProspectMembers(text) {
  const start = String(text || "").indexOf('"AssociatedMembers"');
  if (start < 0) return [];
  const bracket = text.indexOf("[", start);
  if (bracket < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = bracket; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const chunk = text.slice(bracket, end + 1);
  const members = [];
  for (const obj of chunk.split("{").slice(1)) {
    const steam = obj.match(/"UserID"\s*:\s*"?(\d{17})"?/);
    if (!steam) continue;
    const character = obj.match(/"CharacterName"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const account = obj.match(/"AccountName"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const name = jsonStringValue(character?.[1]) || jsonStringValue(account?.[1]);
    members.push({
      steamId: steam[1],
      name,
      playing: /"IsCurrentlyPlaying"\s*:\s*true/i.test(obj)
    });
  }
  return members;
}

async function resolveProspectFile(server) {
  const dir = path.join(server.install || "", "Icarus", "Saved", "PlayerData", "DedicatedServer", "Prospects");
  const names = [
    server?.icarus?.loadProspect,
    server?.icarus?.lastProspectName,
    server?.icarus?.createSave
  ].map(name => String(name || "").trim()).filter(Boolean);
  try {
    const raw = await readFile(settingsIniPath(server), "utf8");
    const last = readIniValue(raw, "LastProspectName");
    const load = readIniValue(raw, "LoadProspect");
    if (last) names.unshift(last);
    if (load) names.unshift(load);
  } catch {
    // use names from state
  }
  const seen = new Set();
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const file = path.join(dir, name.toLowerCase().endsWith(".json") ? name : `${name}.json`);
    if (await pathExists(file)) return file;
  }
  try {
    const files = (await readdir(dir)).filter(file => file.toLowerCase().endsWith(".json"));
    const ranked = await Promise.all(files.map(async file => {
      const full = path.join(dir, file);
      const st = await stat(full);
      return { full, m: st.mtimeMs };
    }));
    ranked.sort((a, b) => b.m - a.m);
    return ranked[0]?.full || "";
  } catch {
    return "";
  }
}

async function prospectMembers(server) {
  try {
    const file = await resolveProspectFile(server);
    if (!file) return [];
    return parseProspectMembers(await readFileHead(file));
  } catch {
    return [];
  }
}

async function steamPersonaName(steamId) {
  const id = String(steamId || "").trim();
  if (!/^\d{17}$/.test(id)) return "";
  const cached = steamNameCache.get(id);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.name;
  try {
    const res = await fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
      headers: { "User-Agent": "IcarusServerManager/1.0" },
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return cached?.name || "";
    const xml = await res.text();
    const match = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/i)
      || xml.match(/<steamID>([^<]+)<\/steamID>/i);
    const name = String(match?.[1] || "").trim();
    if (name && !/^unknown$/i.test(name)) {
      steamNameCache.set(id, { name, at: Date.now() });
      return name;
    }
  } catch {
    // Steam profile lookup is best-effort
  }
  return cached?.name || "";
}

function isJunkPlayerName(name, exclude = new Set()) {
  const text = String(name || "").trim();
  if (text.length < 2 || text.length > 32) return true;
  if (/^[\x00-\x1f]+$/.test(text)) return true;
  if (/^(unknown|null|none|player|dedicatedserver|server)$/i.test(text)) return true;
  if (/^(openworld_|outpost|olympus|prometheus|tier\d+_)/i.test(text)) return true;
  if (exclude.has(text.toLowerCase())) return true;
  return false;
}

function mergePlayerLists(...lists) {
  const byName = new Map();
  for (const list of lists) {
    for (const entry of list || []) {
      const name = String(entry?.name || entry || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const prev = byName.get(key) || { name, ping: null };
      const ping = sanitizePing(entry?.ping);
      if (ping != null) prev.ping = ping;
      prev.name = name;
      byName.set(key, prev);
    }
  }
  return [...byName.values()];
}

function pingFromA2sScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 64) return sanitizePing(n * 4);
  return sanitizePing(n);
}

function sanitizePing(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 0 && n < 1 ? n * 1000 : n;
  if (!Number.isFinite(ms) || ms < 1 || ms > 2500) return null;
  return Math.round(ms);
}

function parsePingFromLine(line) {
  const text = String(line || "");
  const patterns = [
    /(?:AverageInPing|InPing|OutPing|PingMS|ExactPingV2|ExactPing|AvgLag)\s*[=:]\s*(\d+(?:\.\d+)?)/i,
    /(?<![A-Za-z])(?:Ping|RTT|Lag)\s*[=:]\s*(\d+(?:\.\d+)?)\s*ms\b/i,
    /(?<![A-Za-z])(?:Ping|RTT|Lag)\s*[=:]\s*(\d+(?:\.\d+)?)(?:\s|$|,|;|\))/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const ping = sanitizePing(match[1]);
    if (ping != null) return ping;
  }
  return null;
}

function extractIpv4(text) {
  const match = String(text || "").match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (!match) return "";
  const ip = match[1];
  const parts = ip.split(".").map(part => Number(part));
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return "";
  if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) return "";
  if (ip === "255.255.255.255") return "";
  return ip;
}

async function icmpPingMs(host) {
  const ip = extractIpv4(host);
  if (!ip) return null;
  const cached = icmpCache.get(ip);
  if (cached && Date.now() - cached.at < 10000 && cached.ms != null) return cached.ms;
  if (cached && cached.ms == null && Date.now() - cached.at < 3000) return null;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$r = Test-Connection -ComputerName '${ip}' -Count 1 -ErrorAction SilentlyContinue; if ($null -eq $r) { '' } elseif ($null -ne $r.ResponseTime) { $r.ResponseTime } else { $r.Latency }`
        ],
        { windowsHide: true, timeout: 4000 }
      );
      const raw = String(stdout || "").trim();
      const ms = raw === "0" ? 1 : sanitizePing(raw);
      icmpCache.set(ip, { ms, at: Date.now() });
      return ms;
    }
    const { stdout } = await execFileAsync("ping", ["-c", "1", "-W", "1", ip], { timeout: 2500 });
    const text = String(stdout || "");
    let ms = null;
    if (/time[<]\s*1\s*ms/i.test(text)) ms = 1;
    else {
      const match = text.match(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
      ms = match ? sanitizePing(match[1]) : null;
    }
    icmpCache.set(ip, { ms, at: Date.now() });
    return ms;
  } catch {
    icmpCache.set(ip, { ms: null, at: Date.now() });
    return null;
  }
}

function tcpConnectRttMs(host, port = 443) {
  const ip = extractIpv4(host);
  if (!ip) return Promise.resolve(null);
  return new Promise(resolve => {
    const start = Date.now();
    const sock = net.connect({ host: ip, port, timeout: 800 });
    const finish = ok => {
      const ms = Date.now() - start;
      try { sock.destroy(); } catch { /* ignore */ }
      if (!ok || ms >= 800) return resolve(null);
      resolve(sanitizePing(ms) || (ms > 0 ? Math.max(1, Math.round(ms)) : null));
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(true));
    sock.once("timeout", () => finish(false));
  });
}

async function peerRttMs(host) {
  const icmp = await icmpPingMs(host);
  if (icmp != null) return icmp;
  return tcpConnectRttMs(host);
}

async function recentGameUdpPeerIps(gamePort) {
  const port = Number(gamePort);
  if (!port) return [];
  const files = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "LogFiles", "Firewall", "pfirewall.log"),
    "C:\\Windows\\System32\\LogFiles\\Firewall\\pfirewall.log"
  ];
  const seen = new Set();
  const ips = [];
  for (const filePath of [...new Set(files)]) {
    let text = "";
    try { text = await readLogTail(filePath, 512 * 1024); } catch { continue; }
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/\bALLOW\b/i.test(line) || !/\bUDP\b/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const actionIdx = parts.findIndex(part => /^ALLOW$/i.test(part));
      if (actionIdx < 0 || actionIdx + 5 >= parts.length) continue;
      const src = parts[actionIdx + 2];
      const dst = parts[actionIdx + 3];
      const srcPort = Number(parts[actionIdx + 4]);
      const dstPort = Number(parts[actionIdx + 5]);
      let peer = "";
      if (dstPort === port) peer = extractIpv4(src);
      else if (srcPort === port) peer = extractIpv4(dst);
      if (!peer || seen.has(peer)) continue;
      seen.add(peer);
      ips.push(peer);
    }
  }
  return ips.slice(-8);
}

async function enableFirewallAllowedLog() {
  if (process.platform !== "win32") return;
  await runCaptured("netsh", ["advfirewall", "set", "allprofiles", "logging", "allowedconnections", "enable"], 8000);
  await runCaptured("netsh", ["advfirewall", "set", "allprofiles", "logging", "maxfilesize", "4096"], 8000);
}

async function tcpRemoteIpsForPid(pid) {
  const id = Number(pid);
  if (!id || process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -OwningProcess ${id} -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -and $_.RemoteAddress -notmatch '^(127\\.|0\\.0\\.0\\.0|::1?$|::)' } | Select-Object -ExpandProperty RemoteAddress -Unique`
      ],
      { windowsHide: true, timeout: 4000 }
    );
    return [...new Set(String(stdout || "").split(/\r?\n/).map(line => extractIpv4(line.trim())).filter(Boolean))];
  } catch {
    return [];
  }
}

function playersFromLogText(text, excludeNames = []) {
  const exclude = new Set((excludeNames || []).map(name => String(name || "").trim().toLowerCase()).filter(Boolean));
  const byName = new Map();
  const steamToName = new Map();
  const steamOnline = new Set();
  const lines = String(text || "").split(/\r?\n/);
  const join = /(?:logged in|has joined|joined the (?:server|game|session)|connected to server|Join succeeded).*?(?:['"]([^'"]{2,32})['"]|:\s*(\p{L}[\p{L}0-9 _.\-]{1,31}))/iu;
  const playerJoin = /\bPlayer\s+['"]?(\p{L}[\p{L}0-9 _.\-]{1,31})['"]?\s+(?:has\s+)?(?:joined|connected|logged in)/iu;
  const leave = /(?:logged out|has left|was kicked|was banned)\b.*?(?:['"]([^'"]{2,32})['"]|:\s*(\p{L}[\p{L}0-9 _.\-]{1,31}))/iu;
  const addSteam = /(?:Adding user|Adding P2P|RegisterConnection).*?\b(\d{17})\b/i;
  const dropSteam = /(?:Removing P2P|PendingConnectionLost|Closing.*connection|Connection closed).*?(\d{17})/i;
  const pingBySteam = new Map();
  const steamToIp = new Map();
  let lastName = "";
  const upsert = (name, ping) => {
    if (isJunkPlayerName(name, exclude)) return;
    const key = name.toLowerCase();
    const prev = byName.get(key) || { name, ping: null };
    const nextPing = sanitizePing(ping);
    if (nextPing != null) prev.ping = nextPing;
    prev.name = name;
    byName.set(key, prev);
    lastName = name;
  };
  for (const line of lines) {
    const ping = parsePingFromLine(line);
    const added = line.match(addSteam);
    if (added) steamOnline.add(added[1]);
    const steamIdOnLine = line.match(/\b(\d{17})\b/);
    const ip = extractIpv4(line);
    if (steamIdOnLine && ip) steamToIp.set(steamIdOnLine[1], ip);
    if (ping != null && steamIdOnLine) pingBySteam.set(steamIdOnLine[1], ping);
    const dropped = line.match(dropSteam);
    if (dropped) {
      steamOnline.delete(dropped[1]);
      const mapped = steamToName.get(dropped[1]);
      if (mapped) byName.delete(mapped.toLowerCase());
    }
    const steamName = line.match(/user (\d{17}).*\(Name:\s*([^)\]]+?)(?:\s*\[|$)/i);
    if (steamName && !/unknown/i.test(steamName[2])) {
      steamToName.set(steamName[1], steamName[2].trim());
    }
    let match = line.match(leave);
    if (match) {
      const name = (match[1] || match[2] || "").trim();
      if (name) byName.delete(name.toLowerCase());
      continue;
    }
    match = line.match(join) || line.match(playerJoin);
    if (match) {
      const name = (match[1] || match[2] || "").trim();
      upsert(name, ping);
      continue;
    }
    if (ping != null && lastName && byName.has(lastName.toLowerCase())) {
      upsert(lastName, ping);
    }
  }
  for (const id of steamOnline) {
    const name = steamToName.get(id);
    if (name) upsert(name, pingBySteam.get(id));
  }
  return { players: [...byName.values()], steamIds: [...steamOnline], pingBySteam, steamToIp };
}

async function playersFromLogs(server) {
  try {
    const icarus = server?.icarus || {};
    const exclude = [icarus.lastProspectName, icarus.loadProspect, icarus.createSave, server?.profile];
    const text = await readLogTail(shooterLogPath(server), 8 * 1024 * 1024);
    return playersFromLogText(text, exclude);
  } catch {
    return { players: [], steamIds: [], pingBySteam: new Map(), steamToIp: new Map() };
  }
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
    return decodeLogBuffer(buf);
  } finally {
    await fh.close();
  }
}

async function readFileHead(filePath, maxBytes = 768 * 1024) {
  if (!(await pathExists(filePath))) return "";
  const fh = await open(filePath, "r");
  try {
    const st = await fh.stat();
    const length = Math.min(maxBytes, st.size);
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
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

const steamNameCache = new Map();
const icmpCache = new Map();
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
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'IcarusServer.exe' -or $_.Name -eq 'IcarusServer-Win64-Shipping.exe' } | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
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

async function findProcessForInstall(serverOrInstall, procs = null) {
  const server = serverOrInstall && typeof serverOrInstall === "object" ? serverOrInstall : { install: serverOrInstall };
  const install = String(server.install || "").trim();
  if (!install) return null;
  const target = path.normalize(install).toLowerCase();
  const attached = path.normalize(String(server.exe || "")).toLowerCase();
  const list = procs || await getArkProcessesCached();
  return list.find(p => {
    const exe = path.normalize(p.exe || "").toLowerCase();
    if (!exe) return false;
    if (attached && exe === attached) return true;
    return exe.includes(target);
  }) || null;
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

function applyRoster(runtime, list) {
  const prevPing = new Map((runtime.playersOnline || []).map(player => [
    String(player.name || "").toLowerCase(),
    sanitizePing(player.ping)
  ]));
  const players = (Array.isArray(list) ? list : [])
    .map(entry => {
      if (!entry) return null;
      const name = String(typeof entry === "string" ? entry : entry.name || "").trim();
      if (isJunkPlayerName(name)) return null;
      return { name, ping: sanitizePing(entry?.ping) ?? prevPing.get(name.toLowerCase()) ?? null };
    })
    .filter(Boolean);
  runtime.playersOnline = players;
  runtime.playerNames = players.map(player => player.name);
}

async function refreshPlayerRoster(server, runtime, queryPort, liveCount = null) {
  const [fromLog, queried, members] = await Promise.all([
    playersFromLogs(server),
    queryLocalA2sPlayers(queryPort),
    prospectMembers(server)
  ]);
  const a2sNames = Array.isArray(queried) ? queried : [];
  const knownCount = liveCount != null ? Math.max(0, Number(liveCount) || 0) : null;
  if (knownCount === 0) {
    applyRoster(runtime, []);
    runtime.players = 0;
    return;
  }

  const steamIds = Array.isArray(fromLog?.steamIds) ? fromLog.steamIds : [];
  const pingBySteam = fromLog?.pingBySteam instanceof Map ? fromLog.pingBySteam : new Map();
  const steamToIp = fromLog?.steamToIp instanceof Map ? fromLog.steamToIp : new Map();
  const pingOf = async id => {
    const logged = sanitizePing(pingBySteam.get(id));
    if (logged != null) return logged;
    const ip = steamToIp.get(id);
    return ip ? peerRttMs(ip) : null;
  };
  const bySteam = new Map((members || []).map(member => [member.steamId, member]));
  const playing = [];
  for (const member of members || []) {
    if (!member.playing || !member.name) continue;
    playing.push({ name: member.name, ping: await pingOf(member.steamId) });
  }
  const fromSteamIds = [];
  const unresolved = [];
  for (const id of steamIds) {
    const member = bySteam.get(id);
    const ping = await pingOf(id);
    if (member?.name) fromSteamIds.push({ name: member.name, ping });
    else unresolved.push(id);
  }
  if (unresolved.length) {
    const personas = await Promise.all(unresolved.map(id => steamPersonaName(id)));
    const pings = await Promise.all(unresolved.map(id => pingOf(id)));
    personas.forEach((name, index) => {
      const ping = pings[index];
      if (name) fromSteamIds.push({ name, ping });
      else fromSteamIds.push({ name: `Player ${String(unresolved[index]).slice(-4)}`, ping });
    });
  }

  const usableA2s = a2sNames.filter(player => !isJunkPlayerName(player?.name));
  let roster = [];
  if (usableA2s.length) roster = usableA2s;
  else if (knownCount > 0) roster = mergePlayerLists(playing, fromSteamIds).filter(player => !isJunkPlayerName(player?.name));

  if (knownCount != null && roster.length > knownCount) roster = roster.slice(0, knownCount);

  if (roster.some(player => sanitizePing(player.ping) == null)) {
    const gamePort = parseGamePort(server.launchArgs);
    const peers = [
      ...await recentGameUdpPeerIps(gamePort),
      ...(roster.length === 1 ? await tcpRemoteIpsForPid(runtime.pid) : [])
    ];
    const unique = [...new Set(peers)].slice(0, 8);
    const samples = (await Promise.all(unique.map(peerRttMs))).filter(value => value != null);
    if (samples.length === 1 || (samples.length && roster.length === 1)) {
      const ping = Math.max(...samples);
      for (const player of roster) {
        if (sanitizePing(player.ping) == null) player.ping = ping;
      }
    }
  }

  applyRoster(runtime, roster);
  if (knownCount != null) runtime.players = knownCount;
  else if (!Number(runtime.players)) runtime.players = roster.length;
}

async function refreshRuntime(server, { deep = false, procs = null } = {}) {
  const runtime = runtimeOf(server.id);
  runtime.playerNames ||= [];
  runtime.playersOnline ||= [];
  if (runtime.updating) {
    runtime.status = "Updating";
    return;
  }
  const match = await findProcessForInstall(server, procs);
  runtime.maxPlayers = parseMaxPlayers(server);
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

    const queryPort = parseQueryPort(server.launchArgs);
    const info = await queryLocalA2s(queryPort);
    if (info) {
      const ready = await detectReadyFromLogs(server.install);
      const young = Boolean(runtime.startedAt && Date.now() - runtime.startedAt < 2 * 60 * 1000);
      runtime.availability = !young || ready ? "Online" : "Starting…";
      runtime.players = Number(info.players) || 0;
      runtime.maxPlayers = Number(info.max_players) || runtime.maxPlayers;
      await refreshPlayerRoster(server, runtime, queryPort, runtime.players);
      if (young && !ready && !(runtime.playersOnline || []).length) runtime.players = 0;
      return;
    }

    const rconPlayers = await queryPlayerCountViaRcon(server);
    if (rconPlayers != null) {
      runtime.players = rconPlayers;
    }

    await refreshPlayerRoster(server, runtime, queryPort, rconPlayers);

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
    runtime.playerNames = [];
    runtime.playersOnline = [];
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProcessGone(server, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    processCache.at = 0;
    const match = await findProcessForInstall(server);
    if (!match) return true;
    await terminatePid(match.pid);
    await delay(500);
  }
  processCache.at = 0;
  return !(await findProcessForInstall(server));
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
  const elevatedScript = `$ErrorActionPreference = 'Stop'; ${lines.join("; ")}; & netsh advfirewall set allprofiles logging allowedconnections enable | Out-Null; & netsh advfirewall set allprofiles logging maxfilesize 4096 | Out-Null; exit 0`;
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
  await enableFirewallAllowedLog().catch(() => {});
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
  if (runtime.updating) {
    throw Object.assign(new Error("Server is already running or updating"), { status: 409 });
  }
  if (String(runtime.status).toLowerCase() === "running") {
    throw Object.assign(new Error("Server is already running or updating"), { status: 409 });
  }
  if (!server.install) throw Object.assign(new Error("Install location is not set"), { status: 400 });
  const exe = await resolveExePath(server);
  if (!(await pathExists(exe))) {
    throw Object.assign(new Error(`IcarusServer.exe was not found in:\n${server.install}`), { status: 404 });
  }
  server.exe = exe;
  const existing = await findProcessForInstall(server);
  if (existing) {
    runtime.status = "running";
    runtime.pid = existing.pid;
    runtime.startedAt = Date.now();
    runtime.availability = "Online";
    return publicServer(server);
  }

  server.launchArgs = applyIcarusLaunchArgs(server);
  await writeIcarusSettings(server);
  await ensureModsFolder(server);
  if (server.icarus.prospectMode === "create" && createProspectLine(server.icarus)) {
    server.icarus.prospectMode = "resume";
  }
  scheduleSave();

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
  runtime.playerNames = [];
  runtime.playersOnline = [];
  runtime.maxPlayers = parseMaxPlayers(server);
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

  const match = await findProcessForInstall(server);
  const pid = match?.pid || runtime.pid;
  if (pid) await terminatePid(pid);
  const gone = await waitForProcessGone(server);
  if (!gone) {
    appendConsoleLog(server.id, "Stop requested, but IcarusServer.exe is still running.", "error");
  } else {
    await delay(1500);
  }

  runtime.status = "stopped";
  runtime.pid = null;
  runtime.startedAt = 0;
  runtime.availability = "Offline";
  runtime.players = 0;
  runtime.playerNames = [];
  runtime.playersOnline = [];
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
  appendConsoleLog(server.id, `Install folder: ${server.install}`, "system");

  let payload;
  let shouldComplete = false;
  try {
    let steamcmdExe = path.join(server.steamcmd || "", "steamcmd.exe");
    if (!(await pathExists(steamcmdExe))) {
      appendConsoleLog(server.id, "SteamCMD.exe was not found — downloading it so this update can run…", "system");
      const dest = await downloadSteamCmd(server.steamcmd || undefined);
      server.steamcmd = dest;
      steamcmdExe = path.join(dest, "steamcmd.exe");
      scheduleSave();
      if (!(await pathExists(steamcmdExe))) {
        throw Object.assign(new Error("SteamCMD download finished but steamcmd.exe is missing"), { status: 500 });
      }
      appendConsoleLog(server.id, `SteamCMD ready at ${dest}`, "system");
    }

    const running = await findProcessForInstall(server);
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

    appendConsoleLog(server.id, `Updating/validating app ${STEAM_APP_ID} into ${server.install}`, "system");
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
      const exe = await resolveExePath(server);
      if (await pathExists(exe)) {
        server.exe = exe;
        appendConsoleLog(server.id, `Attached to ${exe}`, "system");
      } else {
        appendConsoleLog(server.id, "Update finished, but IcarusServer.exe was not found in the install folder.", "error");
      }
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
    payload = { ...publicServer(server), needsRepair: Boolean(runtime.needsRepair), updateExitCode: result.code };
    shouldComplete = typeof onComplete === "function" && !hit06;
  } finally {
    runtime.updating = false;
    if (runtime.status === "Updating") runtime.status = "stopped";
  }
  if (shouldComplete) {
    try { await onComplete(); } catch (err) { addActivity(err.message, "error"); }
  }
  return payload;
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

async function resolveContentPaksDir(server) {
  const install = String(server.install || "").trim();
  if (!install) return "";
  const candidates = [
    path.join(install, "Icarus", "Content", "Paks"),
    path.join(install, "Content", "Paks")
  ];
  for (const dir of candidates) {
    if (await pathExists(dir)) return dir;
  }
  return candidates[0];
}

async function ensureModsFolder(server) {
  if (!server.install) throw Object.assign(new Error("Install location is not set"), { status: 400 });
  const paks = await resolveContentPaksDir(server);
  const mods = path.join(paks, "mods");
  await mkdir(mods, { recursive: true });
  return mods;
}

function safeModFileName(name) {
  const base = path.basename(String(name || "").trim());
  if (!/^[A-Za-z0-9][A-Za-z0-9._ \-]{0,120}\.(pak|utoc|ucas)$/i.test(base)) return "";
  return base;
}

function modFilePath(server, name, folder) {
  const safe = safeModFileName(name);
  if (!safe || !folder) return "";
  const dir = path.resolve(folder);
  const full = path.resolve(dir, safe);
  if (!isPathInside(dir, full)) return "";
  return full;
}

async function listModFiles(server) {
  const folder = await ensureModsFolder(server);
  const files = [];
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const safe = safeModFileName(entry.name);
    if (!safe) continue;
    const st = await stat(path.join(folder, entry.name));
    files.push({
      name: entry.name,
      exists: true,
      bytes: st.size,
      sizeLabel: formatBytes(st.size),
      modified: st.mtime.toISOString()
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { folder, files };
}

async function addModFile(server, { name, source } = {}) {
  const folder = await ensureModsFolder(server);
  const from = String(source || "").trim();
  if (!from) throw Object.assign(new Error("Paste the path to a .pak (or .utoc/.ucas) file to copy in"), { status: 400 });
  if (!(await pathExists(from))) throw Object.assign(new Error("Source file was not found"), { status: 404 });
  const st = await stat(from);
  if (!st.isFile()) throw Object.assign(new Error("Source path must be a file"), { status: 400 });
  const destName = safeModFileName(name) || safeModFileName(from);
  const dest = modFilePath(server, destName, folder);
  if (!dest) throw Object.assign(new Error("Use a .pak, .utoc, or .ucas filename"), { status: 400 });
  if (st.size > 2 * 1024 * 1024 * 1024) throw Object.assign(new Error("Mod files are limited to 2 GB"), { status: 400 });
  await copyFile(from, dest);
  return dest;
}

async function deleteModFile(server, name) {
  const folder = await ensureModsFolder(server);
  const filePath = modFilePath(server, name, folder);
  if (!filePath) throw Object.assign(new Error("Invalid mod filename"), { status: 400 });
  if (!(await pathExists(filePath))) throw Object.assign(new Error("File is not on disk"), { status: 404 });
  await rm(filePath, { force: true });
  return filePath;
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

async function openInExplorer(dir) {
  if (process.platform === "win32") {
    spawn("explorer.exe", [path.resolve(dir)], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
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
  if (flags.configFiles) {
    to.icarus = makeIcarus(from.icarus);
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
          } catch (err) {
            addActivity(`Scheduled shutdown failed for ${server.profile}: ${err.message}`, "error");
            continue;
          }
          if (server.performUpdate) {
            try {
              await runSteamUpdate(server);
            } catch (err) {
              addActivity(`Scheduled update failed for ${server.profile}: ${err.message}`, "error");
            }
          }
          if (server.thenRestart) {
            try {
              await delay(2000);
              await startServer(server);
              addActivity(`Scheduled restart started ${server.profile}`, "success");
            } catch (err) {
              addActivity(`Scheduled restart failed for ${server.profile}: ${err.message}`, "error");
            }
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
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream", ...corsHeaders() });
    res.end(data);
  } catch {
    if (rel !== "/index.html") {
      const index = await readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() });
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

  if (method === "POST" && pathname === "/api/path/browse") {
    if (!isLoopbackRequest(req)) {
      return sendJson(res, 403, { error: "Folder picker only works from this PC. Paste the path instead." });
    }
    const body = (await readBody(req)) || {};
    const result = await browseFolderDialog(body.title || "Select Icarus server folder");
    return sendJson(res, 200, result);
  }

  if (method === "POST" && pathname === "/api/import/inspect") {
    const body = (await readBody(req)) || {};
    const preview = await inspectIcarusInstall(body.source || body.path);
    return sendJson(res, 200, preview);
  }

  if (method === "POST" && pathname === "/api/import/start") {
    const body = (await readBody(req)) || {};
    const copy = Boolean(body.copy);
    const dest = String(body.dest || "").trim();
    const preview = await inspectIcarusInstall(body.source || body.path, { measure: copy });
    if (copy) {
      if (!dest) return sendJson(res, 400, { error: "Choose a destination folder for the copy" });
      if (!preview.copyAllowed) {
        return sendJson(res, 400, {
          error: `This folder is ${preview.sizeLabel}. Copies are limited to 20 GB. Use the folder in place instead.`
        });
      }
    }
    const job = {
      id: randomUUID(),
      status: "queued",
      error: "",
      copy,
      source: preview.install,
      dest: copy ? path.resolve(dest) : preview.install,
      profile: String(body.profile || preview.profile).trim() || preview.profile,
      copiedBytes: 0,
      copiedFiles: 0,
      totalBytes: preview.bytes,
      totalFiles: preview.files,
      cancel: false,
      server: null
    };
    importJobs.set(job.id, job);
    setTimeout(() => importJobs.delete(job.id), 6 * 60 * 60 * 1000);
    runImportJob(job).catch(err => {
      job.status = "error";
      job.error = err.message || "Import failed";
    });
    return sendJson(res, 202, publicImportJob(job));
  }

  if (method === "GET" && pathname.startsWith("/api/import/jobs/")) {
    const id = decodeURIComponent(pathname.slice("/api/import/jobs/".length));
    const job = importJobs.get(id);
    if (!job) return sendJson(res, 404, { error: "Import job not found" });
    return sendJson(res, 200, publicImportJob(job));
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
    if (body.flags?.configFiles) {
      await copyConfigFiles(from, to);
      if (to.install) {
        try { await writeIcarusSettings(to); } catch { /* target install may be empty */ }
      }
    }
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

  if (method === "POST" && action === "attach") {
    const body = (await readBody(req)) || {};
    const target = String(body.path || server.install || "").trim();
    const attached = await attachToIcarusInstall(target);
    server.install = attached.install;
    server.exe = attached.exe;
    await ensureModsFolder(server).catch(() => {});
    scheduleSave();
    addActivity(`Attached ${server.profile} to ${attached.exe}`, "success");
    return sendJson(res, 200, publicServer(server));
  }

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
    if (body.launchArgs !== undefined && !body.icarus) {
      server.icarus.gamePort = parseGamePort(server.launchArgs);
      server.icarus.queryPort = parseQueryPort(server.launchArgs);
    }
    if (body.profile !== undefined && !body.icarus) {
      server.launchArgs = applySteamServerName(server.launchArgs, server.profile);
    }
    if (body.icarus && typeof body.icarus === "object") {
      server.icarus = makeIcarus({ ...server.icarus, ...body.icarus });
      server.launchArgs = applyIcarusLaunchArgs(server);
      if (server.install) {
        try { await writeIcarusSettings(server); } catch { /* install path may not exist yet */ }
      }
    }
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
  if (method === "GET" && action === "mods") {
    if (!server.install) return sendJson(res, 400, { error: "Install location is not set" });
    return sendJson(res, 200, await listModFiles(server));
  }
  if (method === "POST" && action === "mods") {
    const body = (await readBody(req)) || {};
    const filePath = await addModFile(server, body);
    addActivity(`Added mod ${path.basename(filePath)} for ${server.profile}`, "success");
    return sendJson(res, 200, { ok: true, path: filePath, ...(await listModFiles(server)) });
  }
  if (method === "POST" && action === "mods/delete") {
    const body = (await readBody(req)) || {};
    const filePath = await deleteModFile(server, body.name);
    addActivity(`Removed mod ${path.basename(filePath)} for ${server.profile}`, "info");
    return sendJson(res, 200, { ok: true, ...(await listModFiles(server)) });
  }
  if (method === "POST" && action === "mods/open-folder") {
    await readBody(req).catch(() => null);
    const folder = await ensureModsFolder(server);
    await openInExplorer(folder);
    return sendJson(res, 200, { ok: true, folder });
  }
  if (method === "GET" && action === "config-files") {
    if (!server.install) return sendJson(res, 400, { error: "Install location is not set" });
    return sendJson(res, 200, await listConfigFiles(server));
  }
  if (method === "POST" && action === "config-files") {
    const body = (await readBody(req)) || {};
    const filePath = await addConfigFile(server, body);
    addActivity(`Added ${path.basename(filePath)} for ${server.profile}`, "success");
    return sendJson(res, 200, { ok: true, path: filePath, ...(await listConfigFiles(server)) });
  }
  if (method === "POST" && action === "config-files/delete") {
    const body = (await readBody(req)) || {};
    const filePath = await deleteConfigFile(server, body.name);
    addActivity(`Deleted ${path.basename(filePath)} for ${server.profile}`, "info");
    return sendJson(res, 200, { ok: true, ...(await listConfigFiles(server)) });
  }
  if (method === "POST" && action === "config-files/open") {
    const body = (await readBody(req)) || {};
    const filePath = configFilePath(server, body.name);
    if (!filePath) return sendJson(res, 400, { error: "Invalid config filename" });
    if (!server.install) return sendJson(res, 400, { error: "Install location is not set" });
    await openInEditor(filePath);
    return sendJson(res, 200, { ok: true, path: filePath });
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
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
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
    console.log(`  WAN:     forward TCP ${PORT} here for this panel; Icarus needs UDP game + query ports`);
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
