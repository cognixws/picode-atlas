import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAppmap, validateAppmap } from "../lib/appmap.mjs";
import { adapter, builtInRewrites, configErrors, DEFAULT_STATES, statesOf } from "../lib/config.mjs";
import { jobs, parseFilter, sceneFor, shotName, surfaceErrors } from "../lib/registry.mjs";
import { projectKey, targetDir } from "../lib/runner.mjs";
import { clockShift, fill, pick, shiftTimes } from "../lib/scene.mjs";
import { fillCommand } from "../lib/world.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kepler = JSON.parse(readFileSync(join(root, "examples", "kepler", "atlas.json"), "utf8"));

test("the manifest declares the doors the extension uses", () => {
  const m = JSON.parse(readFileSync(join(root, "picode-extension.json"), "utf8"));
  assert.equal(m.id, "atlas");
  assert.deepEqual(m.contributes.artifactKinds.map((k) => `${k.kind}:${k.entry}:${k.page}`), ["appmap:appmap.json:atlas"]);
  assert.equal(m.contributes.workspace.page, "atlas");
  assert.ok(m.ui.pages.some((p) => p.id === "atlas" && p.path === "ui/atlas.html"));
  assert.deepEqual(m.activation.files, ["atlas.json"]);
  assert.equal(m.settings.find((s) => s.key === "pictures_dir").default, "");
});

test("the Kepler example is a valid atlas.json", () => {
  assert.deepEqual(configErrors(kepler), []);
  assert.deepEqual(surfaceErrors(kepler.surfaces, statesOf(kepler)), []);
});

test("configErrors names what a hand edit gets wrong", () => {
  const errs = configErrors({ v: 2, surfaces: 3, worlds: { "Bad Name": { command: "serve" } }, states: { x: { world: "nowhere" } }, capture: { path: "app", viewport: { width: 0 }, clock: { at: "soon" }, rewrites: [["a"]] }, themes: ["sepia"] }).join("\n");
  for (const want of ["v must be 1", "surfaces is a file", "world Bad Name: the name", "command starts the app on {port}", "state x: world nowhere", "capture.path starts", "capture.viewport", "capture.clock.at", "capture.rewrites", "themes is a list"]) assert.ok(errs.includes(want), `missing ${want}\n${errs}`);
});

test("the adapter fills defaults and keeps the built-in rewrites", () => {
  const a = adapter({ v: 1, surfaces: [], worlds: { w: { command: "x {port}" } } }, root);
  assert.equal(a.path, "/");
  assert.deepEqual(a.viewport, { width: 1440, height: 900 });
  assert.equal(a.clock.apiPrefix, null);
  assert.ok(a.rewrites.length >= 2);
  const rules = builtInRewrites("kepler-host", "vega").map(([s, f, t]) => [new RegExp(s, f), t]);
  const swap = (x) => rules.reduce((acc, [re, t]) => acc.replace(re, t), x);
  assert.equal(swap("http://127.0.0.1:52442/x"), "http://127.0.0.1:3000/x");
  assert.equal(swap("lan 192.168.1.40, chrome 141.0.7390.54, bind 0.0.0.0"), "lan 192.168.50.24, chrome 141.0.7390.54, bind 0.0.0.0");
  assert.equal(swap("kepler-host at /home/vega/app, vega@kepler-host"), "atlas-host at /home/atlas-user/app, atlas-user@atlas-host");
  // The user name is a word of the app's own text elsewhere, never rewritten.
  assert.equal(swap("a vega launch"), "a vega launch");
});

test("jobs expand states into worlds and themes; owed and broken are listed", () => {
  const states = statesOf({});
  const surfaces = [
    { id: "inbox", title: "Inbox", area: "inbox", route: "#/inbox", states: ["empty", "populated"] },
    { id: "prefs", title: "Prefs", area: "settings", route: "#/prefs", states: ["default"] },
    { id: "dlg", title: "A dialog", kind: "dialog", area: "app", states: ["default"], owed: "the scene comes later" },
    { id: "keys", title: "Keys", area: "app", route: "#/keys", states: ["empty"], broken: { empty: "no vault in this world" } },
  ];
  assert.deepEqual(surfaceErrors(surfaces, states), []);
  const all = jobs(surfaces, states, ["light", "dark"], { css: "body" });
  assert.deepEqual(all.run.map((j) => `${j.surface.id}.${j.state}@${j.world}`), ["inbox.empty@empty", "inbox.populated@populated", "prefs.default@populated"]);
  assert.equal(all.owed.length, 1);
  assert.equal(all.broken[0].why, "no vault in this world");
  const some = jobs(surfaces, states, ["light", "dark"], { css: "body" }, parseFilter({ id: "inbox", theme: "dark" }));
  assert.deepEqual(some.run.map((j) => `${j.state}:${j.themes}`), ["empty:dark", "populated:dark"]);
  assert.deepEqual(sceneFor(surfaces[0], "empty", { css: "body" }), { id: "inbox--empty", title: "Inbox", wait: { css: "body" }, route: "#/inbox" });
  assert.equal(shotName("inbox", "empty", "dark"), "inbox.empty.dark.png");
});

test("a run writes beside main, never over it", () => {
  assert.equal(targetDir("/p", "kepler", "main"), "/p/kepler/main");
  assert.equal(targetDir("/p", "kepler", "feat/x"), "/p/kepler/branches/feat-x");
  assert.equal(targetDir("/p", "kepler", "HEAD", "0123456789ab"), "/p/kepler/branches/detached-012345678");
  assert.equal(projectKey("My App!"), "my-app");
  assert.equal(fillCommand("serve {port} {tmp}/x {world}", { port: 9, tmp: "/t", world: "empty" }), "serve 9 '/t'/x 'empty'");
  // A folder name is a path for the shell, never code.
  assert.equal(fillCommand("cd {project}", { project: "/a b/$(x)'y" }), "cd '/a b/$(x)'\\''y'");
  assert.equal(projectKey(".."), "project");
});

test("appmap: built from a run, every capture names its provenance", () => {
  const surfaces = [{ id: "inbox", title: "Inbox", area: "inbox", route: "#/inbox", states: ["empty", "populated"] }];
  const shots = {
    "inbox.empty.light.png": { surface: "inbox", state: "empty", theme: "light", sha256: "a", rev: "abc", branch: "main", viewport: "1600x1000@2" },
    "inbox.populated.light.png": { surface: "inbox", state: "populated", theme: "light", sha256: "b", rev: "abc", branch: "main", viewport: "1600x1000@2" },
  };
  const map = buildAppmap({ app: { name: "X", platform: "web", base: "/" }, surfaces, states: DEFAULT_STATES, shots, run: { at: "t", rev: "abc", branch: "main", browser: "b" } });
  assert.equal(validateAppmap(map), null);
  assert.deepEqual(map.screens[0].states.map((s) => `${s.id}:${s.world}:${s.captures.length}`), ["empty:empty:1", "full:populated:1"]);
  const bad = structuredClone(map);
  delete bad.screens[0].states[0].captures[0].commit;
  assert.match(validateAppmap(bad), /lacks commit/);
  bad.screens[0].states[0].captures[0].commit = "abc";
  bad.edges = [{ from: { screen: "inbox" }, to: { screen: "nowhere" }, kind: "declared" }];
  assert.match(validateAppmap(bad), /names a screen/);
  assert.match(validateAppmap({ v: 1, app: { name: "x" }, screens: [{ id: "a", states: [] }, { id: "a", states: [] }] }), /twice/);
  // Provenance is text, not merely truthy; malformed parts are refused, never thrown.
  const odd = structuredClone(map);
  odd.screens[0].states[0].captures[0].commit = true;
  assert.match(validateAppmap(odd), /lacks commit/);
  odd.screens[0].states[0].captures[0].commit = "abc";
  odd.screens[0].states[0].captures[0].file = "../x.png";
  assert.match(validateAppmap(odd), /picture name/);
  odd.screens[0].states[0].captures = 3;
  assert.match(validateAppmap(odd), /captures is a list/);
  assert.match(validateAppmap({ ...map, edges: [null] }), /edge is an object/);
  assert.match(validateAppmap({ ...map, edges: 0 }), /edges is a list/);
});

test("the scene helpers keep their rules", () => {
  assert.equal(pick([{ name: "a", id: 1 }, { name: "b", id: 2 }], "[name=b].id"), 2);
  assert.equal(fill("#/x/{id}", { id: "7" }), "#/x/7");
  assert.throws(() => fill("{nope}", {}), /unknown placeholder/);
  const s = clockShift(Date.parse("2026-10-27T10:00:00Z"), Date.parse("2026-10-07T14:00:30Z"));
  assert.equal(shiftTimes({ createdAt: "2026-10-27T09:59:00Z" }, s.deltaMs, s.dayDelta).createdAt, "2026-10-07T13:59:00.000Z");
});
