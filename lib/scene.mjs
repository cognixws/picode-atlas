// scene — the small languages a capture scene uses: locators, steps, JSON
// picks, {placeholders}, the clock shift and the picture's box. No browser
// here, so every rule is unit-tested (test/scene.test.mjs). Derived from the
// COGNIX[WS] docs capture engine (cfpperche/picode scripts/shots/scene.mjs).

export const STEP_KINDS = ["request", "goto", "click", "type", "hover", "press", "wait", "waitUrl", "scroll"];
const LOCATOR_KEYS = ["role", "text", "label", "placeholder", "testid", "css"];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// A locator is one of role (+name), text, label, placeholder, testid or css,
// optionally inside a css container. A bare string is text.
export function locatorError(loc) {
  if (typeof loc === "string") return loc ? null : "empty locator";
  if (!loc || typeof loc !== "object") return "a locator is a string or an object";
  const keys = LOCATOR_KEYS.filter((k) => k in loc);
  if (keys.length !== 1) return `a locator names exactly one of ${LOCATOR_KEYS.join(", ")}`;
  if ("name" in loc && keys[0] !== "role") return "name goes with role only";
  return null;
}

// Validate one scene; returns a list of problems (empty = valid).
export function sceneErrors(scene, { themes = ["light", "dark"] } = {}) {
  const out = [];
  const where = scene?.id ? `scene ${scene.id}` : "a scene";
  if (!scene || typeof scene !== "object") return ["a scene is a mapping"];
  if (!ID.test(scene.id || "")) out.push(`${where}: id must be kebab-case`);
  if (scene.themes && (!Array.isArray(scene.themes) || scene.themes.some((t) => !themes.includes(t)))) {
    out.push(`${where}: themes must be a list of ${themes.join(", ")}`);
  }
  if (!scene.wait) out.push(`${where}: wait is required (what must be on screen before the shot)`);
  else if (locatorError(scene.wait)) out.push(`${where}: wait: ${locatorError(scene.wait)}`);
  for (const [i, step] of (scene.steps || []).entries()) {
    const kinds = Object.keys(step || {}).filter((k) => STEP_KINDS.includes(k));
    if (kinds.length !== 1) {
      out.push(`${where}: step ${i + 1} must have exactly one of ${STEP_KINDS.join(", ")}`);
      continue;
    }
    const k = kinds[0];
    const v = step[k];
    if (["click", "hover", "wait", "scroll"].includes(k) && locatorError(v)) out.push(`${where}: step ${i + 1} ${k}: ${locatorError(v)}`);
    if (k === "type" && (locatorError(v?.into) || typeof v?.text !== "string")) out.push(`${where}: step ${i + 1} type needs into (a locator) and text`);
    if (k === "request" && (!v?.path || (v.save && typeof v.save !== "object"))) out.push(`${where}: step ${i + 1} request needs a path (and save as a mapping)`);
    if ((k === "goto" || k === "waitUrl") && typeof v !== "string") out.push(`${where}: step ${i + 1} ${k} is a route string`);
    if (k === "press" && typeof v !== "string") out.push(`${where}: step ${i + 1} press is a key name`);
  }
  const shoot = scene.shoot ?? "viewport";
  if (shoot !== "viewport" && locatorError(shoot.element)) out.push(`${where}: shoot is "viewport" or { element: <locator>, padding }`);
  if (shoot !== "viewport" && shoot.padding !== undefined && !paddingOK(shoot.padding)) out.push(`${where}: shoot padding is a number of CSS px or { top, right, bottom, left }`);
  for (const k of ["highlight", "mask", "hide"]) {
    for (const loc of [].concat(scene[k] ?? [])) if (locatorError(loc)) out.push(`${where}: ${k}: ${locatorError(loc)}`);
  }
  return out;
}

// pick(json, "workspaces[].agents[name=Atlas].id") — dots walk keys, `[]`
// flattens an array, `[k=v]` keeps the items whose k is v. The first match
// wins; undefined when nothing matches.
export function pick(json, path) {
  let cur = [json];
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!m) return undefined;
    const [, key, brackets] = m;
    if (key) cur = cur.map((x) => x?.[key]).filter((x) => x !== undefined);
    for (const b of brackets.match(/\[[^\]]*\]/g) || []) {
      const inner = b.slice(1, -1);
      cur = cur.flatMap((x) => (Array.isArray(x) ? x : []));
      if (inner) {
        const [k, v] = inner.split("=");
        cur = cur.filter((x) => String(x?.[k]) === v);
      }
    }
  }
  return cur[0];
}

// "#/agents/{atlas}" with { atlas: "a1" } → "#/agents/a1"; an unknown name
// is an error, not an empty string.
export function fill(text, vars) {
  return text.replace(/\{([a-z][a-z0-9_]*)\}/gi, (_, k) => {
    if (!(k in vars)) throw new Error(`unknown placeholder {${k}}`);
    return vars[k];
  });
}

// fillDeep fills every string inside a locator or a request body.
export function fillDeep(value, vars) {
  if (typeof value === "string") return fill(value, vars);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, vars)]));
  return value;
}

// shiftTimes moves every timestamp in an API response by `deltaMs`, floored to
// the minute (a seed takes a few seconds, never the same number): ISO date
// times anywhere, calendar days (YYYY-MM-DD) by `dayDelta` whole days, and
// epoch numbers under a time-like key (createdAt, ts, startMs, expires…).
const ISO_DT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY = /(?:at|time|ts|date|since|until|start|end|expires?|seen|updated|created)(?:ms|_ms|s)?$/i;
const MIN = 60_000;
const DAY = 86_400_000;

export function shiftTimes(value, deltaMs, dayDelta, key = "") {
  if (typeof value === "string") {
    if (ISO_DT.test(value)) {
      const t = Date.parse(value);
      if (!Number.isNaN(t)) return new Date(Math.floor((t + deltaMs) / MIN) * MIN).toISOString();
    }
    if (ISO_DAY.test(value)) {
      const t = Date.parse(value + "T00:00:00Z");
      if (!Number.isNaN(t)) return new Date(t + dayDelta * DAY).toISOString().slice(0, 10);
    }
    return value;
  }
  if (typeof value === "number" && TIME_KEY.test(key)) {
    if (value > 1.5e12 && value < 2.5e12) return Math.floor((value + deltaMs) / MIN) * MIN;
    if (value > 1.5e9 && value < 2.5e9) return Math.floor((value + deltaMs / 1000) / 60) * 60;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, deltaMs, dayDelta, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, deltaMs, dayDelta, k)]));
  }
  return value;
}

// The shift that puts a world seeded at `realSeed` at `seededAt`: exact
// milliseconds for instants, whole calendar days (UTC) for day keys.
export function clockShift(realSeed, seededAt) {
  return {
    deltaMs: seededAt - realSeed,
    dayDelta: Math.floor(seededAt / DAY) - Math.floor(realSeed / DAY),
  };
}

const SIDES = ["top", "right", "bottom", "left"];
const paddingOK = (p) => (typeof p === "number" && p >= 0) || (p && typeof p === "object" && Object.keys(p).every((k) => SIDES.includes(k)) && Object.values(p).every((v) => typeof v === "number"));

// clipBox is a shoot element's picture: its box plus the padding — one number
// for every side, or { top, right, bottom, left } (a missing side is 16) —
// kept inside the viewport. Per-side padding keeps a neighbour above or
// beside the element out of the picture while the other sides breathe; a
// negative side cuts into the element (a border it shares with a neighbour).
// tallViewport is the viewport height a shoot element needs to be taken
// whole: when its box and bottom padding reach past the screen, the engine
// grows the viewport to that height (the width stays, so the layout keeps its
// breakpoint) instead of cutting the picture at the screen's edge.
export function tallViewport(box, padding = 16, vh) {
  const bottom = typeof padding === "number" ? padding : padding.bottom ?? 16;
  return Math.max(vh, Math.ceil(box.y + box.height + Math.max(0, bottom)));
}

export function clipBox(box, padding = 16, vw, vh) {
  const side = (k) => (typeof padding === "number" ? padding : padding[k] ?? 16);
  const x = Math.max(0, box.x - side("left"));
  const y = Math.max(0, box.y - side("top"));
  return {
    x, y,
    width: Math.min(vw - x, box.x + box.width + side("right") - x),
    height: Math.min(vh - y, box.y + box.height + side("bottom") - y),
  };
}
