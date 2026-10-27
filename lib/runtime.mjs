// runtime — the browser the atlas photographs with: playwright-core and its
// pinned headless Chromium, installed once into the extension's own data
// folder (never the shared cache, which a disk cleanup may empty; never the
// machine's Chrome, whose updates would change every picture).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const PLAYWRIGHT_VERSION = "1.63.0";

export function runtimeDirs(dataDir) {
  return { prefix: join(dataDir, "runtime"), browsers: join(dataDir, "browsers") };
}

// ensure answers {chromium, version}: playwright-core from the runtime
// folder, installing it and the browser the first time.
export async function ensureRuntime(dataDir, log = () => {}) {
  const { prefix, browsers } = runtimeDirs(dataDir);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  const pkg = join(prefix, "node_modules", "playwright-core", "package.json");
  if (!existsSync(pkg)) {
    mkdirSync(prefix, { recursive: true });
    log(`installing playwright-core ${PLAYWRIGHT_VERSION}`);
    await run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", `playwright-core@${PLAYWRIGHT_VERSION}`], { maxBuffer: 16 << 20 });
  }
  const req = createRequire(pkg);
  const pw = req("playwright-core");
  const hasShell = existsSync(browsers) && readdirSync(browsers).some((d) => d.startsWith("chromium_headless_shell-"));
  if (!hasShell) {
    log("installing the headless Chromium (about 100 MB, once)");
    await run(process.execPath, [join(prefix, "node_modules", "playwright-core", "cli.js"), "install", "chromium-headless-shell"], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers }, maxBuffer: 16 << 20 });
  }
  return { chromium: pw.chromium, version: PLAYWRIGHT_VERSION };
}
