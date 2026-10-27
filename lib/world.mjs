// world — start the project's app in one world on a free port, wait until it
// answers, and end it (its whole process group) afterwards.

import { spawn } from "node:child_process";
import net from "node:net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fillCommand(cmd, vars) {
  return cmd.replace(/\{(port|tmp|world|project)\}/g, (_, k) => String(vars[k]));
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
    env: { ...process.env, ...(world.env || {}), ...env },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const exited = new Promise((r) => child.once("exit", r));
  const base = `http://127.0.0.1:${port}`;
  const ready = world.ready || { path: "/" };
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw new EarlyExit(`exited (code ${child.exitCode}) before it answered: ${stderr.trim().split("\n").at(-1) || ""}`);
      try {
        const r = await fetch(base + ready.path);
        if (r.ok && (!ready.contains || (await r.text()).includes(ready.contains))) break;
      } catch { /* not listening yet */ }
      if (i >= 240) throw new Error(`world ${name} did not answer ${ready.path} within two minutes`);
      await sleep(500);
    }
  } catch (e) {
    kill(child);
    throw e;
  }
  log(`world ${name} on ${base}`);
  const release = async () => {
    kill(child);
    await Promise.race([exited, sleep(15000)]);
  };
  return { base, release, seededAt: Date.now() };
}

function kill(child) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
}
