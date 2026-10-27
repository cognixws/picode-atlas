#!/usr/bin/env node
// The atlas without PiCode, for a project's own scripts and CI:
//
//   node cli.mjs run <project> [--out <folder>] [--data <folder>] [--workers n]
//                              [--id a,b] [--area x] [--kind tab] [--state empty] [--theme dark]
//   node cli.mjs validate <appmap.json>

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateAppmap } from "./lib/appmap.mjs";
import { parseFilter } from "./lib/registry.mjs";
import { run } from "./lib/runner.mjs";

function flag(argv, name) {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, target] = argv;
  if (cmd === "validate" && target) {
    const err = validateAppmap(JSON.parse(readFileSync(target, "utf8")));
    console.log(err ? `invalid: ${err}` : "valid");
    return err ? 1 : 0;
  }
  if (cmd !== "run" || !target) {
    console.error("usage: node cli.mjs run <project> [--out <folder>] [--data <folder>] [--workers n] [--id …] [--area …] [--kind …] [--state …] [--theme …]\n       node cli.mjs validate <appmap.json>");
    return 2;
  }
  const projectDir = resolve(target);
  const dataDir = resolve(flag(argv, "data") || join(homedir(), ".local", "share", "picode-atlas"));
  const picturesRoot = resolve(flag(argv, "out") || join(dataDir, "pictures"));
  const filter = parseFilter({ id: flag(argv, "id"), area: flag(argv, "area"), kind: flag(argv, "kind"), state: flag(argv, "state"), theme: flag(argv, "theme") });
  const r = await run({ projectDir, project: flag(argv, "project"), picturesRoot, dataDir, filter, workers: Number(flag(argv, "workers")) || undefined, log: (m) => console.log(`atlas: ${m}`) });
  console.log(`atlas: ${r.written.length} written, ${r.kept} unchanged, ${r.failed.length} failed, ${r.broken.length} broken and ${r.owed.length} owed in ${r.seconds} s`);
  console.log(`atlas: ${r.target}`);
  return r.failed.length ? 1 : 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`atlas: ${e.message}`); process.exit(1); });
