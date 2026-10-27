// runner — one atlas run of a project: set it up, start a fresh world for each
// surface state, photograph each theme, keep a picture only when its bytes
// changed, and write the manifest, the run log, the gallery data and the
// appmap.json an agent can publish.

import { createHash } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildAppmap } from "./appmap.mjs";
import { adapter, readConfig, statesOf } from "./config.mjs";
import { clockShift, shootScene, warmUp } from "./engine.mjs";
import { filtered, jobs, loadSurfaces, parseFilter, shotName, surfaceErrors, THEMES } from "./registry.mjs";
import { ensureRuntime } from "./runtime.mjs";
import { boot, fillCommand } from "./world.mjs";

function git(dir, ...args) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

// Where one run of a project writes: main's pictures are the atlas; a branch
// or a detached checkout writes beside them, never over them.
export function targetDir(root, project, branch, rev = "") {
  const base = join(root, project);
  if (branch === "main" || branch === "master") return join(base, "main");
  if (!branch || branch === "HEAD") return join(base, "branches", "detached-" + (rev.slice(0, 9) || "unknown"));
  return join(base, "branches", branch.replace(/[^a-zA-Z0-9._-]+/g, "-"));
}

export function projectKey(name) {
  return String(name || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

const worldTmp = () => (existsSync("/var/tmp") ? "/var/tmp" : tmpdir());

async function thumbnail(page, png) {
  const url = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = Math.round((img.height * 640) / img.width);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/webp", 0.82);
  }, png.toString("base64"));
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

// run answers {target, written, kept, failed, broken, owed, seconds} or throws
// with a message a person can act on.
export async function run({ projectDir, project, picturesRoot, dataDir, filter = parseFilter(), workers, log = () => {} }) {
  const t0 = Date.now();
  const { config, error } = readConfig(projectDir);
  if (error) throw new Error(error);
  const a = adapter(config, projectDir);
  const states = statesOf(config);
  const surfaces = loadSurfaces(config, projectDir);
  const errs = surfaceErrors(surfaces, states);
  if (errs.length) throw new Error("surfaces: " + errs.slice(0, 5).join("; ") + (errs.length > 5 ? `; and ${errs.length - 5} more` : ""));
  const themes = config.themes || THEMES;
  const { run: todo, broken, owed } = jobs(surfaces, states, themes, a.defaultWait, filter);
  const branch = git(projectDir, "rev-parse", "--abbrev-ref", "HEAD");
  const rev = git(projectDir, "rev-parse", "HEAD");
  const key = projectKey(project || basename(projectDir));
  const target = targetDir(picturesRoot, key, branch, rev);
  const shotsDir = join(target, "shots");
  const thumbsDir = join(target, "thumbs");
  mkdirSync(shotsDir, { recursive: true });
  mkdirSync(thumbsDir, { recursive: true });
  const manifestPath = join(target, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { v: 1, shots: {} };
  const runAt = new Date().toISOString();
  const written = [];
  const kept = [];
  const failed = [];
  let version = "";
  const tmp = mkdtempSync(join(worldTmp(), "atlas-"));
  try {
    if (todo.length) {
      for (const cmd of config.setup || []) {
        log(`setup: ${cmd}`);
        execSync(fillCommand(cmd, { tmp, project: projectDir, port: 0, world: "" }), { cwd: projectDir, stdio: ["ignore", "ignore", "pipe"], shell: "/bin/sh", maxBuffer: 64 << 20 });
      }
      const { chromium, version: v } = await ensureRuntime(dataDir, log);
      version = v;
      const browser = await chromium.launch();
      version = `Chromium ${browser.version()}`;
      const queue = todo.slice();
      const n = Math.max(1, Math.min(workers || Math.min(4, Math.max(1, Math.floor(availableParallelism() / 3))), queue.length));
      log(`${todo.reduce((s, j) => s + j.themes.length, 0)} pictures of ${new Set(todo.map((j) => j.surface.id)).size} surfaces, ${n} at a time, into ${target}`);
      const worker = async () => {
        const thumbPage = await browser.newPage();
        try {
          for (let job = queue.shift(); job; job = queue.shift()) {
            const { surface, state, world, themes: th, scene } = job;
            let w;
            try {
              w = await boot(config.worlds[world], world, { projectDir, tmp, log });
              const shift = a.clock.apiPrefix ? clockShift(w.seededAt, a.clock.seededAt) : null;
              await warmUp(browser, w.base, a, scene, shift);
              for (const theme of th) {
                const file = shotName(surface.id, state, theme);
                try {
                  const png = await shootScene(browser, w.base, a, scene, theme, shift, { hash: !surface.steps && surface.route?.startsWith("#") ? surface.route : undefined });
                  const sha256 = createHash("sha256").update(png).digest("hex");
                  const out = join(shotsDir, file);
                  const thumb = join(thumbsDir, file.replace(/\.png$/, ".webp"));
                  if (manifest.shots[file]?.sha256 === sha256 && existsSync(out)) {
                    kept.push(file);
                    if (!existsSync(thumb)) writeFileSync(thumb, await thumbnail(thumbPage, png));
                    continue;
                  }
                  writeFileSync(out, png);
                  writeFileSync(thumb, await thumbnail(thumbPage, png));
                  manifest.shots[file] = { surface: surface.id, state, theme, sha256, rev, branch, viewport: `${a.viewport.width}x${a.viewport.height}@${a.scale}`, changedAt: runAt };
                  written.push(file);
                  log(`${file} (${(png.length / 1024).toFixed(0)} KB)`);
                } catch (e) {
                  failed.push({ surface: surface.id, state, theme, error: e.message.split("\n")[0] });
                  log(`${file}: ${e.message.split("\n")[0]}`);
                }
              }
            } catch (e) {
              for (const theme of th) failed.push({ surface: surface.id, state, theme, error: e.message.split("\n")[0] });
              log(`${surface.id} (${state}): ${e.message.split("\n")[0]}`);
            } finally {
              await w?.release();
            }
          }
        } finally {
          await thumbPage.close().catch(() => {});
        }
      };
      try {
        await Promise.allSettled(Array.from({ length: n }, worker));
      } finally {
        await browser.close();
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!filtered(filter)) {
    const live = new Set(surfaces.flatMap((s) => (s.states || []).flatMap((st) => themes.map((th) => shotName(s.id, st, th)))));
    for (const file of Object.keys(manifest.shots)) {
      if (live.has(file)) continue;
      delete manifest.shots[file];
      rmSync(join(shotsDir, file), { force: true });
      rmSync(join(thumbsDir, file.replace(/\.png$/, ".webp")), { force: true });
    }
  }
  manifest.v = 1;
  manifest.project = key;
  manifest.updated = runAt;
  if (version) manifest.browser = version;
  manifest.shots = Object.fromEntries(Object.entries(manifest.shots).sort());
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
  const seconds = Math.round((Date.now() - t0) / 1000);
  const line = { at: runAt, rev, branch, filter: filtered(filter) ? filter : null, pictures: written.length + kept.length, written, kept: kept.length, failed, broken, owed: owed.length, seconds };
  appendFileSync(join(target, "runs.jsonl"), JSON.stringify(line) + "\n");
  // The map an agent publishes as ext:atlas/appmap: appmap.json plus every
  // thumbnail in one file (a version holds at most 255 files).
  const appDir = join(target, "appmap");
  mkdirSync(appDir, { recursive: true });
  const app = { name: config.name || key, platform: config.platform || "web", base: a.path };
  const map = buildAppmap({ app, surfaces, states, shots: manifest.shots, run: { at: runAt, rev, branch, browser: manifest.browser || "" } });
  writeFileSync(join(appDir, "appmap.json"), JSON.stringify(map, null, 1) + "\n");
  const thumbs = {};
  for (const file of Object.keys(manifest.shots)) {
    const t = join(thumbsDir, file.replace(/\.png$/, ".webp"));
    if (existsSync(t)) thumbs[file.replace(/\.png$/, ".webp")] = readFileSync(t).toString("base64");
  }
  writeFileSync(join(appDir, "thumbs.json"), JSON.stringify(thumbs) + "\n");
  return { target, written, kept: kept.length, failed, broken, owed, seconds };
}

// gallery answers what the page draws for a project's current target.
export function gallery({ projectDir, project, picturesRoot }) {
  const { config, error } = readConfig(projectDir);
  if (error) return { error };
  const branch = git(projectDir, "rev-parse", "--abbrev-ref", "HEAD");
  const rev = git(projectDir, "rev-parse", "HEAD");
  const target = targetDir(picturesRoot, projectKey(project || basename(projectDir)), branch, rev);
  const manifest = existsSync(join(target, "manifest.json")) ? JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")) : { shots: {} };
  let last = null;
  if (existsSync(join(target, "runs.jsonl"))) last = JSON.parse(readFileSync(join(target, "runs.jsonl"), "utf8").trim().split("\n").at(-1) || "null");
  let surfaces = [];
  let surfacesError = "";
  try {
    surfaces = loadSurfaces(config, projectDir).map(({ id, title, area, kind, route, states, broken, owed }) => ({ id, title, area: area || "app", kind: kind || "route", route: route || "", states, broken: broken || {}, owed: owed || "" }));
  } catch (e) {
    surfacesError = e.message;
  }
  return { project: config.name || basename(projectDir), branch, target, surfaces, surfacesError, shots: manifest.shots, browser: manifest.browser || "", run: last };
}
