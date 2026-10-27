// The Atlas extension's background process: one run at a time, the gallery
// data and pictures for the page, and the validation of every appmap version
// an agent publishes. It answers only PiCode's relay (the proxy secret).

import http from "node:http";
import https from "node:https";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAppmap } from "./lib/appmap.mjs";
import { parseFilter } from "./lib/registry.mjs";
import { gallery, projectKey, run, targetDir } from "./lib/runner.mjs";

const env = process.env;
const dataDir = env.PICODE_EXT_DATA || join(process.cwd(), "data");
const secret = env.PICODE_EXT_PROXY_SECRET || "";
const log = (m) => console.error("[atlas]", m);
const base = env.PICODE_URL ? new URL(env.PICODE_URL) : null;
if (base && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("the Host API must be on loopback");

function host(method, path) {
  return new Promise((resolve, reject) => {
    if (!base) return reject(new Error("no PICODE_URL: start the extension through PiCode"));
    const target = new URL(path, base);
    const client = target.protocol === "https:" ? https : http;
    // PiCode's own certificate on loopback; nothing else is fetched here.
    const req = client.request(target, { method, rejectUnauthorized: false, headers: { "X-PiCode-Extension-Token": env.PICODE_EXT_TOKEN || "" } }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("error", reject);
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { parsed = { error: "unreadable answer" }; }
        if (res.statusCode >= 400) return reject(new Error(parsed.error || `Host API ${res.statusCode}`));
        resolve(parsed);
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error("Host API timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function workspace(id) {
  const r = await host("GET", "/api/ext/v1/workspaces");
  const list = Array.isArray(r) ? r : r.workspaces || [];
  const ws = list.find((w) => w.id === id);
  if (!ws) throw new Error("workspace not found, or the extension is off in it");
  return ws;
}

async function settings() {
  try {
    const r = await host("GET", "/api/ext/v1/settings");
    return r.values || {};
  } catch {
    return {};
  }
}

async function picturesRoot() {
  const dir = String((await settings()).pictures_dir || "").trim();
  return dir || join(dataDir, "pictures");
}

// One run at a time; a workspace waits in the queue once.
const queue = [];
let current = null;
const last = {};
async function pump() {
  if (current || !queue.length) return;
  const job = queue.shift();
  current = job;
  last[job.ws.id] = { state: "running", at: new Date().toISOString() };
  try {
    const workers = job.workers || Number((await settings()).workers) || undefined;
    const result = await run({ projectDir: job.ws.path, project: job.ws.id, picturesRoot: await picturesRoot(), dataDir, filter: job.filter, workers, log });
    last[job.ws.id] = { state: "done", at: new Date().toISOString(), written: result.written.length, kept: result.kept, failed: result.failed.length, seconds: result.seconds };
  } catch (e) {
    last[job.ws.id] = { state: "failed", at: new Date().toISOString(), error: e.message.split("\n")[0] };
    log(`run failed: ${e.message}`);
  } finally {
    current = null;
    pump();
  }
}

const SHOT = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.(?:light|dark)\.(png|webp)$/;
const CHUNK = 750 * 1024;

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  try {
    if (secret && req.headers["x-picode-proxy-secret"] !== secret) return send(res, 403, { error: "only PiCode's relay reaches this process" });
    const url = new URL(req.url, "http://localhost");
    const q = url.searchParams;
    if (req.method === "POST" && url.pathname === "/__picode/artifact/validate") {
      const b = await readBody(req);
      // PiCode sends the stored kind (ext:atlas/appmap); the declared one is appmap.
      if (String(b.kind || "").replace(/^ext:atlas\//, "") !== "appmap") return send(res, 200, { ok: false, error: `unknown kind ${b.kind}` });
      if (!(b.files || []).some((f) => f.path === "appmap.json")) return send(res, 200, { ok: false, error: "the version holds no appmap.json" });
      if (typeof b.entryText !== "string") return send(res, 200, { ok: false, error: "appmap.json is larger than 1 MiB or not text" });
      let map;
      try { map = JSON.parse(b.entryText); } catch (e) { return send(res, 200, { ok: false, error: "appmap.json is not JSON: " + e.message }); }
      const err = validateAppmap(map);
      return send(res, 200, err ? { ok: false, error: err } : { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, { busy: current ? current.ws.id : null, queue: queue.map((j) => j.ws.id), last });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      const b = await readBody(req);
      const ws = await workspace(String(b.workspace || ""));
      if (!existsSync(join(ws.path, "atlas.json"))) return send(res, 409, { error: "this workspace's folder has no atlas.json" });
      if (current?.ws.id === ws.id || queue.some((j) => j.ws.id === ws.id)) return send(res, 200, { queued: true, already: true });
      queue.push({ ws, filter: parseFilter(b.filter || {}), workers: Number(b.workers) || undefined });
      last[ws.id] = { state: "queued", at: new Date().toISOString() };
      pump();
      return send(res, 202, { queued: true });
    }
    const wsId = q.get("workspace") || "";
    if (req.method === "GET" && url.pathname === "/gallery") {
      const ws = await workspace(wsId);
      const g = gallery({ projectDir: ws.path, project: ws.id, picturesRoot: await picturesRoot() });
      return send(res, 200, { ...g, target: undefined, workspace: { id: ws.id, name: ws.name }, status: last[ws.id] || null, busy: current?.ws.id === ws.id });
    }
    if (req.method === "GET" && (url.pathname === "/thumb" || url.pathname === "/shot")) {
      const file = q.get("file") || "";
      if (!SHOT.test(file)) return send(res, 400, { error: "not a picture name" });
      const ws = await workspace(wsId);
      const g = gallery({ projectDir: ws.path, project: ws.id, picturesRoot: await picturesRoot() });
      if (g.error) return send(res, 409, { error: g.error });
      const path = join(g.target, url.pathname === "/thumb" ? "thumbs" : "shots", file);
      if (!existsSync(path)) return send(res, 404, { error: "no such picture yet" });
      const bytes = readFileSync(path).toString("base64");
      // The relay carries 1 MiB as text: a full picture comes in base64 chunks.
      const chunk = Number(q.get("chunk") || 0);
      const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK));
      return send(res, 200, { data: bytes.slice(chunk * CHUNK, (chunk + 1) * CHUNK), chunk, chunks });
    }
    return send(res, 404, { error: "unknown route" });
  } catch (e) {
    return send(res, 500, { error: e.message.split("\n")[0] });
  }
});

server.listen(Number(env.PICODE_EXT_PORT || 0), "127.0.0.1", () => log(`listening on ${server.address().port}`));
export { projectKey, targetDir };
