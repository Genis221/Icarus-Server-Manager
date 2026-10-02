import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(crypto.scrypt);

const COOKIE_NAME = "icarus_session";
const SESSION_HOURS = 12;
const REMEMBER_DAYS = 30;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const DEFAULT_ADMIN_USERNAME = "Genis221";

export function createAuthController({ dataDir, onActivity } = {}) {
  const authDir = path.join(dataDir, "auth");
  const usersFile = path.join(authDir, "users.json");
  const sessionsFile = path.join(authDir, "sessions.json");

  let users = [];
  let sessions = [];
  const loginAttempts = new Map();

  async function ensureDir() {
    await mkdir(authDir, { recursive: true });
  }

  async function loadJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function saveUsers() {
    await ensureDir();
    await writeFile(usersFile, JSON.stringify({ users }, null, 2), "utf8");
  }

  async function saveSessions() {
    await ensureDir();
    await writeFile(sessionsFile, JSON.stringify({ sessions }, null, 2), "utf8");
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt
    };
  }

  function normalizeUsername(value) {
    return String(value || "").trim();
  }

  function usernameKey(value) {
    return normalizeUsername(value).toLowerCase();
  }

  async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${Buffer.from(derived).toString("base64")}`;
  }

  async function verifyPassword(password, encoded) {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    if (!n || !r || !p || !salt.length || !expected.length) return false;
    const derived = await scryptAsync(String(password), salt, expected.length, { N: n, r, p });
    return crypto.timingSafeEqual(Buffer.from(derived), expected);
  }

  function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
  }

  function parseCookies(req) {
    const header = req.headers.cookie || "";
    const out = {};
    for (const part of String(header).split(";")) {
      const index = part.indexOf("=");
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!key) continue;
      out[key] = decodeURIComponent(value);
    }
    return out;
  }

  function isSecureRequest(req) {
    if (req.socket?.encrypted) return true;
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    return proto === "https";
  }

  function clientIp(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return forwarded || req.socket?.remoteAddress || "unknown";
  }

  function buildSetCookie(token, { rememberMe = false, secure = false, clear = false } = {}) {
    const maxAge = clear ? 0 : rememberMe ? REMEMBER_DAYS * 24 * 60 * 60 : SESSION_HOURS * 60 * 60;
    const parts = [
      `${COOKIE_NAME}=${clear ? "" : encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`
    ];
    if (secure) parts.push("Secure");
    return parts.join("; ");
  }

  function pruneSessions() {
    const nowMs = Date.now();
    const before = sessions.length;
    sessions = sessions.filter(session => Date.parse(session.expiresAt) > nowMs);
    return sessions.length !== before;
  }

  function findUserByUsername(username) {
    const key = usernameKey(username);
    return users.find(user => usernameKey(user.username) === key) || null;
  }

  function findUserById(id) {
    return users.find(user => user.id === id) || null;
  }

  function attemptKey(ip, username) {
    return `${ip}|${usernameKey(username) || "?"}`;
  }

  function checkRateLimit(ip, username) {
    const key = attemptKey(ip, username);
    const nowMs = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry) return null;
    if (entry.resetAt <= nowMs) {
      loginAttempts.delete(key);
      return null;
    }
    if (entry.count >= MAX_FAILED) {
      const seconds = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
      return `Too many failed sign-in attempts. Try again in ${seconds} seconds.`;
    }
    return null;
  }

  function recordFailedAttempt(ip, username) {
    const key = attemptKey(ip, username);
    const nowMs = Date.now();
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= nowMs) {
      loginAttempts.set(key, { count: 1, resetAt: nowMs + LOCK_MS });
      return;
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILED) entry.resetAt = nowMs + LOCK_MS;
  }

  function clearFailedAttempts(ip, username) {
    loginAttempts.delete(attemptKey(ip, username));
  }

  function emitActivity(type, title, detail) {
    if (typeof onActivity === "function") onActivity(type, title, detail);
  }

  async function init() {
    await ensureDir();
    const userData = await loadJson(usersFile, { users: [] });
    const sessionData = await loadJson(sessionsFile, { sessions: [] });
    users = Array.isArray(userData.users) ? userData.users : [];
    sessions = Array.isArray(sessionData.sessions) ? sessionData.sessions : [];
    if (pruneSessions()) await saveSessions();

    let unlocked = false;
    for (const user of users) {
      if (user.lockedUntil && Date.parse(user.lockedUntil) <= Date.now()) {
        user.lockedUntil = null;
        user.failedLogins = 0;
        unlocked = true;
      }
    }
    if (unlocked) await saveUsers();

    const resetRequested = /^(1|true|yes)$/i.test(String(process.env.ICARUS_RESET_ADMIN_PASSWORD || "").trim());
    if (resetRequested) {
      const username = normalizeUsername(process.env.ICARUS_ADMIN_USERNAME) || DEFAULT_ADMIN_USERNAME;
      let password = String(process.env.ICARUS_ADMIN_PASSWORD || "").trim();
      let generated = false;
      if (!password) {
        password = crypto.randomBytes(18).toString("base64url");
        generated = true;
      }
      let user = findUserByUsername(username);
      if (!user) {
        user = {
          id: crypto.randomUUID(),
          username,
          passwordHash: await hashPassword(password),
          role: "admin",
          createdAt: new Date().toISOString(),
          failedLogins: 0,
          lockedUntil: null
        };
        users.push(user);
      } else {
        user.passwordHash = await hashPassword(password);
        user.role = "admin";
        user.failedLogins = 0;
        user.lockedUntil = null;
      }
      sessions = sessions.filter(session => session.userId !== user.id);
      loginAttempts.clear();
      await saveUsers();
      await saveSessions();
      console.log("");
      console.log("Icarus Server Manager reset the admin password.");
      console.log(`  Username: ${user.username}`);
      if (generated) {
        console.log(`  Temporary password: ${password}`);
        console.log("  Sign in, then change this password under Account.");
      } else {
        console.log("  Password: (from ICARUS_ADMIN_PASSWORD)");
      }
      console.log("  Remove ICARUS_RESET_ADMIN_PASSWORD after you sign in so it is not reset again.");
      console.log("");
      emitActivity("setup", "Admin password reset", `Password for “${user.username}” was reset from the host.`);
      return;
    }

    if (!users.length) {
      const username = normalizeUsername(process.env.ICARUS_ADMIN_USERNAME) || DEFAULT_ADMIN_USERNAME;
      let password = process.env.ICARUS_ADMIN_PASSWORD || "";
      let generated = false;
      if (!password) {
        password = crypto.randomBytes(18).toString("base64url");
        generated = true;
      }
      const user = {
        id: crypto.randomUUID(),
        username,
        passwordHash: await hashPassword(password),
        role: "admin",
        createdAt: new Date().toISOString(),
        failedLogins: 0,
        lockedUntil: null
      };
      users.push(user);
      await saveUsers();
      console.log("");
      console.log("Icarus Server Manager created the first admin account.");
      console.log(`  Username: ${username}`);
      if (generated) {
        console.log(`  Temporary password: ${password}`);
        console.log("  Sign in, then change this password under Account.");
      } else {
        console.log("  Password: (from ICARUS_ADMIN_PASSWORD)");
      }
      console.log("");
      emitActivity("setup", "Admin account created", `First operator account “${username}” is ready.`);
    }
  }

  function isUserLocked(user) {
    if (!user?.lockedUntil) return false;
    return Date.parse(user.lockedUntil) > Date.now();
  }

  async function resolveSession(req) {
    pruneSessions();
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const session = sessions.find(item => item.tokenHash === tokenHash);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      sessions = sessions.filter(item => item.id !== session.id);
      await saveSessions();
      return null;
    }
    const user = findUserById(session.userId);
    if (!user) {
      sessions = sessions.filter(item => item.id !== session.id);
      await saveSessions();
      return null;
    }
    const nowMs = Date.now();
    session.lastSeenAt = new Date(nowMs).toISOString();
    if (session.rememberMe) {
      session.expiresAt = new Date(nowMs + REMEMBER_DAYS * 24 * 60 * 60 * 1000).toISOString();
    }
    await saveSessions();
    return { user, session, token };
  }

  async function requireUser(req) {
    const auth = await resolveSession(req);
    if (!auth) throw Object.assign(new Error("Sign in required."), { status: 401 });
    return auth;
  }

  async function requireAdmin(req) {
    const auth = await requireUser(req);
    if (auth.user.role !== "admin") throw Object.assign(new Error("Admin access required."), { status: 403 });
    return auth;
  }

  function appendCookie(res, cookie) {
    const existing = res.getHeader("set-cookie");
    if (!existing) res.setHeader("Set-Cookie", cookie);
    else if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, cookie]);
    else res.setHeader("Set-Cookie", [existing, cookie]);
  }

  async function login(req, res, body = {}) {
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const rememberMe = Boolean(body.rememberMe);
    const ip = clientIp(req);
    const rateError = checkRateLimit(ip, username);
    if (rateError) throw Object.assign(new Error(rateError), { status: 429 });

    const invalid = Object.assign(new Error("Invalid username or password."), { status: 401 });
    const user = findUserByUsername(username);
    if (!user || !password) {
      recordFailedAttempt(ip, username);
      emitActivity("config", "Sign-in failed", `Failed sign-in from ${ip}`);
      throw invalid;
    }
    if (isUserLocked(user)) {
      throw Object.assign(new Error("This account is temporarily locked. Try again later."), { status: 423 });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      recordFailedAttempt(ip, username);
      user.failedLogins = Number(user.failedLogins || 0) + 1;
      if (user.failedLogins >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
        user.failedLogins = 0;
      }
      await saveUsers();
      emitActivity("config", "Sign-in failed", `Failed sign-in for “${user.username}” from ${ip}`);
      throw invalid;
    }

    clearFailedAttempts(ip, username);
    user.failedLogins = 0;
    user.lockedUntil = null;
    await saveUsers();

    const token = crypto.randomBytes(32).toString("base64url");
    const nowMs = Date.now();
    const ttlMs = rememberMe ? REMEMBER_DAYS * 24 * 60 * 60 * 1000 : SESSION_HOURS * 60 * 60 * 1000;
    const session = {
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      rememberMe,
      createdAt: new Date(nowMs).toISOString(),
      lastSeenAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      ip,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 240)
    };
    sessions.push(session);
    await saveSessions();
    appendCookie(res, buildSetCookie(token, { rememberMe, secure: isSecureRequest(req) }));
    emitActivity("config", "Signed in", `${user.username} signed in${rememberMe ? " (keep me logged in)" : ""}`);
    return { user: publicUser(user), rememberMe, expiresAt: session.expiresAt };
  }

  async function logout(req, res) {
    const auth = await resolveSession(req);
    if (auth?.session) {
      sessions = sessions.filter(item => item.id !== auth.session.id);
      await saveSessions();
      emitActivity("config", "Signed out", `${auth.user.username} signed out`);
    }
    appendCookie(res, buildSetCookie("", { clear: true, secure: isSecureRequest(req) }));
    return { ok: true };
  }

  async function logoutEverywhere(req, res) {
    const auth = await requireUser(req);
    sessions = sessions.filter(item => item.userId !== auth.user.id);
    await saveSessions();
    appendCookie(res, buildSetCookie("", { clear: true, secure: isSecureRequest(req) }));
    emitActivity("config", "Signed out everywhere", `${auth.user.username} ended all sessions`);
    return { ok: true };
  }

  async function status(req) {
    const auth = await resolveSession(req);
    return {
      configured: users.length > 0,
      authenticated: Boolean(auth),
      user: auth ? publicUser(auth.user) : null
    };
  }

  async function listUsers(req) {
    await requireAdmin(req);
    return { users: users.map(publicUser) };
  }

  async function createUser(req, body = {}) {
    await requireAdmin(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "operator";
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      throw Object.assign(new Error("Username must be 3–32 characters (letters, numbers, . _ -)."), { status: 400 });
    }
    if (password.length < 10) throw Object.assign(new Error("Password must be at least 10 characters."), { status: 400 });
    if (findUserByUsername(username)) throw Object.assign(new Error("That username is already taken."), { status: 409 });
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      role,
      createdAt: new Date().toISOString(),
      failedLogins: 0,
      lockedUntil: null
    };
    users.push(user);
    await saveUsers();
    emitActivity("config", "User added", `Account “${username}” (${role}) was created`);
    return { user: publicUser(user) };
  }

  async function deleteUser(req, userId) {
    const auth = await requireAdmin(req);
    if (auth.user.id === userId) throw Object.assign(new Error("You cannot delete the account you are signed in with."), { status: 400 });
    const target = findUserById(userId);
    if (!target) throw Object.assign(new Error("User not found."), { status: 404 });
    const admins = users.filter(user => user.role === "admin");
    if (target.role === "admin" && admins.length <= 1) {
      throw Object.assign(new Error("You cannot delete the last admin account."), { status: 400 });
    }
    users = users.filter(user => user.id !== userId);
    sessions = sessions.filter(session => session.userId !== userId);
    await saveUsers();
    await saveSessions();
    emitActivity("config", "User removed", `Account “${target.username}” was deleted`);
    return { ok: true };
  }

  async function changePassword(req, body = {}) {
    const auth = await requireUser(req);
    const currentPassword = String(body.currentPassword || "");
    const nextPassword = String(body.newPassword || "");
    if (nextPassword.length < 10) throw Object.assign(new Error("New password must be at least 10 characters."), { status: 400 });
    const ok = await verifyPassword(currentPassword, auth.user.passwordHash);
    if (!ok) throw Object.assign(new Error("Current password is incorrect."), { status: 401 });
    auth.user.passwordHash = await hashPassword(nextPassword);
    auth.user.failedLogins = 0;
    auth.user.lockedUntil = null;
    await saveUsers();
    sessions = sessions.filter(session => !(session.userId === auth.user.id && session.id !== auth.session.id));
    await saveSessions();
    emitActivity("config", "Password changed", `${auth.user.username} updated their password`);
    return { ok: true };
  }

  function isPublicApi(pathname, method) {
    if (pathname === "/api/auth/login" && method === "POST") return true;
    if (pathname === "/api/auth/status" && method === "GET") return true;
    return false;
  }

  return {
    COOKIE_NAME,
    init,
    status,
    login,
    logout,
    logoutEverywhere,
    listUsers,
    createUser,
    deleteUser,
    changePassword,
    requireUser,
    requireAdmin,
    resolveSession,
    isPublicApi,
    publicUser,
    appendCookie,
    buildSetCookie
  };
}
