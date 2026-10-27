# Atlas — a COGNIX[WS] extension

Atlas photographs every screen of the web app a workspace builds — empty and
with data, light and dark — the same way every time, and keeps the pictures
as a gallery in the workspace and as an **app map** you can publish and
comment on. Agents use it to see the screens they changed; people use it to
review a branch by its screens.

It is the union of two COGNIX[WS] designs: the screen atlas (ADR-0382) and
the app map (ADR-0278), amended 2026-10-27.

## What it does

- **A world per picture.** The project says, in `atlas.json`, how its app
  starts in each world (a command with `{port}`): an empty one, a seeded one,
  whatever the project needs. Every surface state gets a freshly started
  world, so one picture never depends on another.
- **Pictures that repeat.** A fixed page clock (and, if the app has a JSON
  API, its times moved to that clock), a quiet network before the shutter,
  animations off, the pointer parked. A picture is rewritten only when its
  bytes changed.
- **Refuses a broken screen.** A screen that still shows a loading skeleton,
  shows an error, or lands on another address fails its scene instead of
  becoming its picture.
- **Private by default.** Loopback ports, private and Tailscale addresses,
  and the capturing machine's host and user names never reach a picture.
- **Gallery and map.** The workspace's **Atlas** entry draws every screen
  with its states side by side. Each run also leaves an `appmap/` folder an
  agent publishes as the artifact kind `ext:atlas/appmap`; the extension
  validates every version (each picture names its commit, branch, viewport,
  theme, role and world).

Web apps only, in a pinned headless Chromium (Playwright). It is not a
cross-browser test runner and sends nothing anywhere.

## Install

In COGNIX[WS]: **Extensions → Install**, source
`https://github.com/cognixws/picode-atlas`. The first run downloads
`playwright-core` and its headless Chromium (about 100 MB to download, about
270 MB on disk) into the extension's own data folder.

Settings: **Pictures folder** (empty keeps them in the extension's folder
inside COGNIX[WS]'s data folder; any folder works, another disk for
example) and **Worlds at once**.

The extension turns itself on in every workspace whose folder has an
`atlas.json` at its root.

## atlas.json

```json
{
  "v": 1,
  "name": "Kepler",
  "surfaces": [
    {"id": "home", "title": "Home", "area": "site", "route": "/", "states": ["default"], "wait": {"css": "h1"}}
  ],
  "states": {"default": {"world": "site", "appmap": "full"}},
  "worlds": {
    "site": {"command": "python3 -m http.server {port} --bind 127.0.0.1", "ready": {"path": "/"}}
  },
  "capture": {"path": "/", "viewport": {"width": 1440, "height": 900}, "scale": 2}
}
```

| Field | Meaning |
|---|---|
| `surfaces` | A list, a file of the project, or `{command}` whose output is the list. Each surface: `id`, `title`, `area`, `kind`, `route` (a path, or a hash opened on `capture.path`) or `steps`, `states`, `wait`, and `broken` / `owed` reasons |
| `states` | Each state's world and its name in the app map. Defaults: `empty` (world `empty`), `populated` and `default` (world `populated`) |
| `worlds` | `command` with `{port}` (and `{tmp}`, the run's own folder), `env`, `ready: {path, contains}` |
| `setup` | Commands run once before a run, in the project's folder |
| `capture` | `path`, `viewport`, `scale`, `init` (scripts run before the app), `theme` (`{localStorage: key}`), `notReadyText`, `css`, `rewrites`, `fulfill` (fixed API answers), `clock` (`{at, timezone, api}`), `refuse` (`{loading, css, text}`), `wait` (the default) |

Examples: [`examples/kepler/atlas.json`](examples/kepler/atlas.json), and
COGNIX[WS]'s own `atlas.json` at the root of `cfpperche/picode`.

## Without COGNIX[WS]

```bash
node cli.mjs run <project folder> --out <pictures folder> [--id home,book] [--state empty] [--theme dark]
node cli.mjs validate <appmap.json>
```

## Development

```bash
npm test
```

Roadmap: [BACKLOG.md](BACKLOG.md). License: Apache-2.0.
