// registry — the surfaces a project lists, and the capture jobs they make.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sceneErrors } from "./scene.mjs";

export const KINDS = ["route", "tab", "dialog", "overlay", "menu", "native"];
export const THEMES = ["light", "dark"];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// loadSurfaces reads the list from atlas.json's `surfaces`: a file of the
// project ({surfaces: [...]} or a list), a list inline, or {command}, whose
// output is that JSON (a project resolves its own references that way).
export function loadSurfaces(c, projectDir) {
  const src = c.surfaces;
  let doc;
  if (Array.isArray(src)) doc = src;
  else if (typeof src === "string") doc = JSON.parse(readFileSync(resolve(projectDir, src), "utf8"));
  else doc = JSON.parse(execFileSync("sh", ["-c", src.command], { cwd: projectDir, encoding: "utf8", maxBuffer: 32 << 20 }));
  return Array.isArray(doc) ? doc : doc.surfaces || [];
}

export function surfaceErrors(surfaces, states) {
  const out = [];
  const seen = new Set();
  for (const s of surfaces) {
    const where = `surface ${s.id || "?"}`;
    if (!ID.test(s.id || "")) out.push(`${where}: id must be kebab-case`);
    if (seen.has(s.id)) out.push(`${where}: duplicate id`);
    seen.add(s.id);
    if (s.kind && !KINDS.includes(s.kind)) out.push(`${where}: kind must be one of ${KINDS.join(", ")}`);
    if (!s.title) out.push(`${where}: title is required`);
    const st = s.states || [];
    if (!st.length || st.some((x) => !states[x])) out.push(`${where}: states must be among ${Object.keys(states).join(", ")}`);
    const hasGoto = (s.steps || []).some((x) => x && "goto" in x);
    if (!s.route && !hasGoto && !s.owed) out.push(`${where}: a route, or steps with a goto, says where the surface is`);
    if (!s.owed) for (const e of sceneErrors({ ...sceneFor(s, st[0] || "default", { css: "body" }), id: ID.test(s.id || "") ? s.id : "x" })) out.push(`${where}: ${e.replace(/^scene [^:]+: /, "")}`);
  }
  return out;
}

export function sceneFor(s, state, defaultWait) {
  const scene = { id: `${s.id}--${state}`, title: s.title, wait: s.wait ?? defaultWait };
  if (s.steps) scene.steps = s.steps;
  else scene.route = s.route;
  for (const k of ["settle", "shoot", "mask", "hide", "keepScroll"]) if (s[k] !== undefined) scene[k] = s[k];
  return scene;
}

export function parseFilter(src = {}) {
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  return { id: list(src.id), area: list(src.area), kind: list(src.kind), state: list(src.state), theme: list(src.theme) };
}

export const filtered = (f) => Object.values(f).some((v) => v.length);

// jobs: one per surface and state, with its world and the themes to take.
// An owed or broken state is reported, never photographed.
export function jobs(surfaces, states, themes, defaultWait, filter = parseFilter()) {
  const keep = (vals, v) => !vals.length || vals.includes(v);
  const out = { run: [], broken: [], owed: [] };
  for (const s of surfaces) {
    if (!keep(filter.id, s.id) || !keep(filter.area, s.area) || !keep(filter.kind, s.kind)) continue;
    for (const state of s.states) {
      if (!keep(filter.state, state)) continue;
      const th = themes.filter((t) => keep(filter.theme, t));
      if (!th.length) continue;
      if (s.owed) { out.owed.push({ surface: s.id, state, why: s.owed }); continue; }
      if (s.broken?.[state]) { out.broken.push({ surface: s.id, state, why: s.broken[state] }); continue; }
      out.run.push({ surface: s, state, world: states[state].world, themes: th, scene: sceneFor(s, state, defaultWait) });
    }
  }
  return out;
}

export const shotName = (surface, state, theme) => `${surface}.${state}.${theme}.png`;
