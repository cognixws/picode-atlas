// world — start the project's app in one world on a free port, wait until it
// answers, and end it (its whole process group) afterwards.

import { spawn } from "node:child_process";
import net from "node:net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Values are shell-quoted: a folder named with spaces or $(…) stays a path.
const quote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
export function fillCommand(cmd, vars) {
  return cmd.replace(/\{(port|tmp|world|project)\}/g, (_, k) => (k === "port" ? String(vars[k]) : quote(vars[k])));
}

// The project's commands never see the extension's own credentials.
export function projectEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PICODE_EXT_")));
  return { ...env, ...extra };
}

// Every world still running, so the process can end them all if it is stopped.
const live = new Set();
export function killAll() {
  for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  live.clear();
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

class EarlyExit extends Error {}

// boot starts a world; a world that exits before it answers starts again on
// another port, three times at most (another process can take a probed port).
export async function boot(world, name, { projectDir, tmp, env = {}, log = () => {} }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await bootOnce(world, name, { projectDir, tmp, env, log });
    } catch (e) {
      if (!(e instanceof EarlyExit) || attempt >= 3) throw e;
      log(`world ${name}: ${e.message}; starting it again on another port`);
    }
  }
}

async function bootOnce(world, name, { projectDir, tmp, env, log }) {
  const port = await freePort();
  const cmd = fillCommand(world.command, { port, tmp, world: name, project: projectDir });
  const child = spawn("sh", ["-c", cmd], {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: projectEnv({ ...(world.env || {}), ...env }),
  });
  live.add(child.pid);
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise((r) => child.once("exit", r));
  const base = `http://127.0.0.1:${port}`;
  const ready = world.ready || { path: "/" };
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw new EarlyExit(`exited (code ${child.exitCode}) before it answered: ${stderr.trim().split("\n").at(-1) || ""}`);
      try {
        const r = await fetch(base + ready.path, { signal: AbortSignal.timeout(5000) });
        // An answer counts only while our own child is alive: a port probed
        // free can be taken by another server in between.
        if (r.ok && (!ready.contains || (await r.text()).includes(ready.contains)) && child.exitCode === null) break;
      } catch { /* not listening yet */ }
      if (i >= 240) throw new Error(`world ${name} did not answer ${ready.path} within two minutes`);
      await sleep(500);
    }
  } catch (e) {
    await stop(child, exited);
    throw e;
  }
  log(`world ${name} on ${base}`);
  const release = () => stop(child, exited);
  return { base, release, seededAt: Date.now() };
}

// stop ends the world's process group: SIGTERM, then SIGKILL after 10 s.
async function stop(child, exited) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  const done = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
  if (!done) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } await Promise.race([exited, sleep(2000)]); }
  live.delete(child.pid);
}
