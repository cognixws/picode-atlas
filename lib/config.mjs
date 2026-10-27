// config — a project's atlas.json: how to start the app in each world and how
// to photograph it. Validated before anything starts (test/config.test.mjs);
// the adapter it builds is all the engine knows about the product.

import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";

export const CONFIG_FILE = "atlas.json";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// What the extension always rewrites in a picture, whatever the project:
// a loopback server's port (it changes every run), private and Tailscale
// addresses, and the capturing machine's own host and user names.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function builtInRewrites(host = hostname(), user = safeUser()) {
  return [
    ["(127\\.0\\.0\\.1|localhost):\\d{2,5}", "g", "$1:3000"],
    ["(?<![\\w.])(?:10\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3})\\.\\d{1,3}(?![\\w.])", "g", "192.168.50.24"],
    ...(host && host.length > 2 ? [[`\\b${escapeRe(host)}\\b`, "gi", "atlas-host"]] : []),
    // The user name only where it names the machine's user: a home folder or
    // user@host, never a word of the app's own text.
    ...(user && user.length > 1 ? [[`(/home/|/Users/|\\\\Users\\\\)${escapeRe(user)}\\b`, "g", "$1atlas-user"], [`\\b${escapeRe(user)}@`, "g", "atlas-user@"]] : []),
  ];
}
function safeUser() {
  try { return userInfo().username; } catch { return ""; }
}

// The states a surface lists, the world each is taken in and the name it
// carries in appmap.json (ADR-0278's state names). A project may add its own.
export const DEFAULT_STATES = {
  empty: { world: "empty", appmap: "empty" },
  populated: { world: "populated", appmap: "full" },
  default: { world: "populated", appmap: "full" },
};

export function readConfig(projectDir) {
  const file = join(projectDir, CONFIG_FILE);
  if (!existsSync(file)) return { error: `no ${CONFIG_FILE} at the root of ${projectDir}` };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `${CONFIG_FILE} is not valid JSON: ${e.message}` };
  }
  const errors = configErrors(raw);
  if (errors.length) return { error: `${CONFIG_FILE}: ${errors.join("; ")}` };
  return { config: raw };
}

export function configErrors(c) {
  const out = [];
  if (!c || typeof c !== "object") return ["the file holds an object"];
  if (c.v !== 1) out.push("v must be 1");
  if (!(typeof c.surfaces === "string" || Array.isArray(c.surfaces) || (c.surfaces && typeof c.surfaces.command === "string"))) out.push("surfaces is a file, a list, or {command}");
  if (c.setup !== undefined && (!Array.isArray(c.setup) || c.setup.some((s) => typeof s !== "string"))) out.push("setup is a list of commands");
  const worlds = c.worlds || {};
  if (!Object.keys(worlds).length) out.push("worlds names at least one world");
  for (const [name, w] of Object.entries(worlds)) {
    if (!ID.test(name)) out.push(`world ${name}: the name is kebab-case`);
    if (!w || typeof w.command !== "string" || !w.command.includes("{port}")) out.push(`world ${name}: command starts the app on {port}`);
    if (w?.ready !== undefined && (typeof w.ready !== "object" || typeof w.ready.path !== "string" || !w.ready.path.startsWith("/"))) out.push(`world ${name}: ready is {path, contains}`);
  }
  const states = { ...DEFAULT_STATES, ...(c.states || {}) };
  for (const [name, s] of Object.entries(c.states || {})) {
    if (!ID.test(name)) out.push(`state ${name}: the name is kebab-case`);
    if (!s || typeof s.world !== "string") out.push(`state ${name}: world is required`);
  }
  for (const [name, s] of Object.entries(states)) if (s.world && !worlds[s.world] && (c.states || {})[name]) out.push(`state ${name}: world ${s.world} is not declared`);
  const cap = c.capture || {};
  if (cap.path !== undefined && (typeof cap.path !== "string" || !cap.path.startsWith("/"))) out.push("capture.path starts with /");
  if (cap.viewport !== undefined && !(cap.viewport.width > 0 && cap.viewport.height > 0)) out.push("capture.viewport is {width, height}");
  if (cap.clock?.at !== undefined && Number.isNaN(Date.parse(cap.clock.at))) out.push("capture.clock.at is an ISO instant");
  for (const r of cap.rewrites || []) if (!Array.isArray(r) || r.length !== 3) out.push("capture.rewrites holds [source, flags, replacement]");
  if (c.themes !== undefined && (!Array.isArray(c.themes) || c.themes.some((t) => t !== "light" && t !== "dark"))) out.push("themes is a list of light and dark");
  return out;
}

// The adapter the engine reads: every product-specific choice in one object.
export function adapter(c, projectDir) {
  const cap = c.capture || {};
  const theme = cap.theme || {};
  return {
    path: cap.path || "/",
    viewport: cap.viewport || { width: 1440, height: 900 },
    scale: cap.scale || 2,
    mobile: !!cap.mobile,
    initScripts: (cap.init || []).map((f) => readFileSync(resolve(projectDir, f), "utf8")),
    themeInit: theme.localStorage
      ? (t) => `try { localStorage.setItem(${JSON.stringify(theme.localStorage)}, ${JSON.stringify(t)}); } catch {}`
      : null,
    notReadyText: cap.notReadyText || [],
    captureCss: cap.css ?? "*, *::before, *::after { caret-color: transparent !important; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }",
    captureInitCss: cap.initCss ?? "html, html * { scroll-behavior: auto !important; }",
    rewrites: [...(cap.rewrites || []), ...builtInRewrites()],
    fulfill: cap.fulfill || [],
    clock: {
      seededAt: Date.parse(cap.clock?.at || "2026-01-07T12:00:30Z"),
      timezone: cap.clock?.timezone || "UTC",
      apiPrefix: cap.clock?.api || null,
    },
    refuse: {
      loading: cap.refuse?.loading || [],
      loadingMs: cap.refuse?.loadingMs ?? 8000,
      css: cap.refuse?.css || [],
      text: cap.refuse?.text || [],
    },
    defaultWait: cap.wait || { css: "body" },
  };
}

export function statesOf(c) {
  return { ...DEFAULT_STATES, ...(c.states || {}) };
}
