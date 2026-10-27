---
name: atlas
description: Photograph every screen of this workspace's web app (empty and with data, light and dark) with the Atlas extension, read the pictures, and publish the app map. Use after changing a screen, or when asked what the app looks like.
---

# Atlas

The Atlas extension photographs the screens a project lists in `atlas.json`
at the root of the workspace's folder, each in its states, and keeps a
gallery (the workspace's **Atlas** entry) and an app map you can publish.

## When the project has no atlas.json

Write one. It says how the app starts in each world and which screens it
has:

```json
{
  "v": 1,
  "name": "My app",
  "surfaces": [
    {"id": "home", "title": "Home", "area": "app", "route": "/", "states": ["empty", "populated"]}
  ],
  "worlds": {
    "empty": {"command": "npm run dev -- --port {port}", "env": {"SEED": "none"}, "ready": {"path": "/"}},
    "populated": {"command": "npm run seed && npm run dev -- --port {port}", "ready": {"path": "/"}}
  },
  "capture": {"path": "/", "viewport": {"width": 1440, "height": 900}}
}
```

- A route is a path (`/settings`) or a hash (`#/inbox`, opened on
  `capture.path`). A surface whose address takes an id finds it with steps:
  `{"request": {"path": "/api/items", "save": {"item": "[].id"}}}` then
  `{"goto": "#/items/{item}"}`.
- `states` name worlds: `empty` and `populated` by default, `default` for a
  screen that does not depend on data. A state a world cannot show yet is
  listed under `broken` with the reason.
- `setup` holds commands run once before a run (`{tmp}` is the run's own
  folder): building the app, for example.

## After changing a screen

Ask the owner to press **Photograph now** in the workspace's Atlas entry, or
run the extension's CLI from its package folder:
`node cli.mjs run <workspace folder> --id <surface> --out <folder>`.
Then read the pictures it names: `shots/<surface>.<state>.<theme>.png`. A
run refuses a screen that shows an error, a loading skeleton, or lands on
another address: fix the screen, not the check.

## Publishing the app map

Each run leaves `appmap/` in its folder: `appmap.json` (screens, states,
every picture with its commit, branch, viewport, theme, role and world) and
`thumbs.json`. Publish that folder as the artifact kind `ext:atlas/appmap`
(the artifacts tool, action publish, `kind`). The extension checks it before
it is stored; a map without provenance is refused.
