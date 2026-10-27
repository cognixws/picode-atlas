// engine — photograph one scene of a running app, the same way every time.
// Derived from the COGNIX[WS] docs capture engine (cfpperche/picode
// scripts/shots/run.mjs); everything it knew about one product now comes from
// the project's atlas.json through an adapter (lib/config.mjs).
//
// What holds a picture still: a fixed page clock and, when the project asks,
// API answers moved to that clock; a quiet network before the shutter; no
// service worker; smooth scrolling off; the pointer in a corner; horizontal
// scroll reset. What a picture refuses: a loading skeleton, an error box or
// line, a page that left its address.

import { clipBox, clockShift, fill, fillDeep, pick, shiftTimes, tallViewport } from "./scene.mjs";

const CLOCK_OFFSET_MS = 60_000;

export { clockShift };

// A browser context for one scene in one theme.
export async function sceneContext(browser, a, shift, theme) {
  const context = await browser.newContext({
    viewport: a.viewport,
    deviceScaleFactor: a.scale,
    isMobile: !!a.mobile,
    hasTouch: !!a.mobile,
    timezoneId: a.clock.timezone,
    serviceWorkers: "block",
    ...(theme ? { colorScheme: theme } : {}),
  });
  if (theme && a.themeInit) await context.addInitScript(a.themeInit(theme));
  for (const code of a.initScripts) await context.addInitScript(code);
  await context.addInitScript(`document.addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    s.textContent = ${JSON.stringify(a.captureInitCss)};
    document.head.appendChild(s);
  });`);
  context.inflight = 0;
  const prefix = a.clock.apiPrefix;
  if (prefix || a.fulfill.length) {
    // A late answer after the scene closed its context is dropped, never
    // re-sent: the request may already have reached the server.
    await context.route((url) => (prefix && url.pathname.startsWith(prefix)) || a.fulfill.some((f) => f.path === url.pathname), (route) => answer(route).catch(() => {}));
  }
  async function answer(route) {
    const req = route.request();
    if ((req.headers().accept || "").includes("text/event-stream")) return route.continue();
    const path = new URL(req.url()).pathname;
    const stub = a.fulfill.find((f) => f.path === path && (f.method || "GET") === req.method());
    if (stub) return route.fulfill({ json: stub.json });
    let res;
    context.inflight++;
    try {
      res = await route.fetch();
    } catch {
      return route.continue();
    } finally {
      context.inflight--;
    }
    if (!(res.headers()["content-type"] || "").includes("json")) return route.fulfill({ response: res });
    let json;
    try {
      json = await res.json();
    } catch {
      return route.fulfill({ response: res });
    }
    return route.fulfill({ response: res, json: shift ? shiftTimes(json, shift.deltaMs, shift.dayDelta) : json });
  }
  return context;
}

export function locate(page, loc) {
  if (typeof loc === "string") return page.getByText(loc, { exact: false }).first();
  const root = loc.within ? page.locator(loc.within).first() : page;
  if (loc.role) return root.getByRole(loc.role, loc.name ? { name: loc.name, exact: false } : {}).first();
  if (loc.text) return root.getByText(loc.text, { exact: false }).first();
  if (loc.label) return root.getByLabel(loc.label).first();
  if (loc.placeholder) return root.getByPlaceholder(loc.placeholder).first();
  if (loc.testid) return root.getByTestId(loc.testid).first();
  return root.locator(loc.css).first();
}

export async function step(page, base, s, vars) {
  const [kind] = Object.keys(s);
  const v = kind === "request" ? { ...s[kind], body: fillDeep(s[kind].body, vars) } : fillDeep(s[kind], vars);
  if (kind === "request") {
    const res = await page.request.fetch(base + fill(v.path, vars), { method: v.method || "GET", data: v.body });
    if (!res.ok()) throw new Error(`request ${v.method || "GET"} ${v.path}: HTTP ${res.status()}`);
    const json = await res.json().catch(() => null);
    for (const [name, path] of Object.entries(v.save || {})) {
      const val = pick(json, path);
      if (val === undefined) throw new Error(`request ${v.path}: nothing at ${path}`);
      vars[name] = String(val);
    }
  } else if (kind === "goto") {
    const route = fill(v, vars);
    if (route.startsWith("#")) await page.evaluate((h) => { location.hash = h; }, route);
    else await page.goto(base + route);
  } else if (kind === "click") await locate(page, v).click();
  else if (kind === "hover") await locate(page, v).hover();
  else if (kind === "type") await locate(page, v.into).fill(v.text);
  else if (kind === "press") await page.keyboard.press(v);
  else if (kind === "scroll") {
    if (v.top === undefined) await locate(page, v).scrollIntoViewIfNeeded();
    else await locate(page, v).evaluate((node, top) => {
      let s = node.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s || document.scrollingElement).scrollBy(0, node.getBoundingClientRect().top - top);
    }, v.top);
  } else if (kind === "wait") await locate(page, v).waitFor({ state: "visible", timeout: 20_000 });
  else if (kind === "waitUrl") await page.waitForFunction((t) => location.href.includes(t), v, { timeout: 20_000 });
}

async function quietNetwork(context) {
  const deadline = Date.now() + 10_000;
  let quietSince = context.inflight === 0 ? Date.now() : 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (context.inflight > 0) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= 400) return;
  }
}

// visibleSign answers the first selector with a visible element, or the first
// text the page shows (case-insensitive), or null. It runs in the page.
function visibleSign([selectors, texts]) {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  };
  for (const sel of selectors) for (const el of document.querySelectorAll(sel)) if (shown(el)) return sel;
  const body = (document.body?.innerText || "").toLowerCase();
  for (const t of texts) if (body.includes(t.toLowerCase())) return `"${t}"`;
  return null;
}

async function settleLoading(page, refuse) {
  const deadline = Date.now() + (refuse.loadingMs ?? 8000);
  for (;;) {
    const sign = await page.evaluate(visibleSign, [refuse.loading, []]);
    if (!sign || Date.now() > deadline) return;
    await page.waitForTimeout(200);
  }
}

async function refuseBroken(page, refuse) {
  const loading = await page.evaluate(visibleSign, [refuse.loading, []]);
  if (loading) throw new Error(`still loading at the shutter (${loading})`);
  const broken = await page.evaluate(visibleSign, [refuse.css, refuse.text]);
  if (broken) throw new Error(`the screen shows an error (${broken})`);
}

async function open(page, base, a, scene, vars) {
  await page.clock.install({ time: a.clock.seededAt });
  // A hash route (#/inbox) opens on the app's page; a path route (/about)
  // is an address of its own.
  const route = scene.steps ? "" : fill(scene.route || "", {});
  await page.goto(base + (route.startsWith("/") ? route : a.path + route));
  for (const s of scene.steps || []) await step(page, base, s, vars);
  await locate(page, fillDeep(scene.wait, vars)).waitFor({ state: "visible", timeout: 30_000 });
}

// A first visit can change the world (a page that creates something when it
// opens), so a scene is played once without a shot before its themes.
export async function warmUp(browser, base, a, scene, shift) {
  const context = await sceneContext(browser, a, shift, null);
  const page = await context.newPage();
  try {
    await open(page, base, a, scene, {});
    await page.waitForTimeout(scene.settle ?? 800);
  } finally {
    await context.close();
  }
}

// shootScene photographs one scene in one theme and answers the PNG.
// `hash` is the address the page must stay at (a deeper one is fine).
export async function shootScene(browser, base, a, scene, theme, shift, { hash, debugPath } = {}) {
  const context = await sceneContext(browser, a, shift, theme);
  const page = await context.newPage();
  try {
    const vars = {};
    await open(page, base, a, scene, vars);
    for (const text of a.notReadyText) {
      await page.getByText(text).first().waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {
        throw new Error(`"${text}" is still on screen`);
      });
    }
    await page.waitForTimeout(scene.settle ?? 800);
    await page.waitForFunction(() => {
      const now = location.href;
      if (window.__atlasHref !== now) { window.__atlasHref = now; window.__atlasHrefAt = performance.now(); return false; }
      return performance.now() - window.__atlasHrefAt > 500;
    }, null, { polling: 100, timeout: 10_000 }).catch(() => {});
    await page.evaluate(() => Promise.race([
      Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }))),
      new Promise((r) => setTimeout(r, 10_000)),
    ]));
    const lastStep = Object.keys((scene.steps || []).at(-1) || {})[0];
    if (lastStep !== "hover") {
      await page.mouse.move(a.viewport.width - 1, a.viewport.height - 1);
      await page.evaluate(() => document.activeElement?.blur?.());
    }
    if (!scene.keepScroll) await page.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollLeft) el.scrollLeft = 0; });
    await settleLoading(page, a.refuse);
    await quietNetwork(context);
    await page.clock.pauseAt(a.clock.seededAt + CLOCK_OFFSET_MS);
    await quietNetwork(context);
    await page.waitForTimeout(300);
    await page.evaluate((rules) => {
      const res = rules.map(([src, flags, to]) => [new RegExp(src, flags), to]);
      const swap = (t) => res.reduce((acc, [re, to]) => acc.replace(re, to), t);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const next = swap(n.nodeValue);
        if (next !== n.nodeValue) n.nodeValue = next;
      }
      for (const el of document.querySelectorAll("[title], input, textarea")) {
        if (el.title) el.title = swap(el.title);
        if ("value" in el && typeof el.value === "string") el.value = swap(el.value);
      }
    }, a.rewrites);
    for (const loc of [].concat(scene.hide ?? [])) {
      await locate(page, loc).evaluateAll((els) => els.forEach((el) => el.style.setProperty("visibility", "hidden", "important")));
    }
    await refuseBroken(page, a.refuse);
    if (hash) {
      const at = await page.evaluate(() => decodeURIComponent(location.hash));
      if (at !== hash && !at.startsWith(hash + "/") && !at.startsWith(hash + "?")) throw new Error(`left its address: ${hash} became ${at}`);
    }
    const opts = { animations: "disabled", caret: "hide", style: a.captureCss, mask: [].concat(scene.mask ?? []).map((l) => locate(page, l)) };
    const shoot = scene.shoot ?? "viewport";
    if (shoot !== "viewport") {
      let box = await locate(page, shoot.element).boundingBox();
      if (!box) throw new Error("shoot element is not on screen");
      let vh = a.viewport.height;
      const need = tallViewport(box, shoot.padding ?? 16, vh);
      if (need > vh) {
        vh = need + 240;
        await page.setViewportSize({ width: a.viewport.width, height: vh });
        box = (await locate(page, shoot.element).boundingBox()) ?? box;
      }
      opts.clip = clipBox(box, shoot.padding ?? 16, a.viewport.width, vh);
    }
    return await page.screenshot(opts);
  } catch (e) {
    if (debugPath) await page.screenshot({ path: debugPath }).catch(() => {});
    throw e;
  } finally {
    await context.close();
  }
}
