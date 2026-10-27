# Backlog

The phases of the merged proposal (COGNIX[WS] ADR-0278 and ADR-0382, amended
2026-10-27). U0 is this first release.

- **U1 — the agent's loop.** Agent tools (`shoot`, `diff`, `screens`, `states`)
  through an executor; a panel beside the agent; a message to the agent when
  a long run ends.
- **U2 — the map.** Declared edges from the project's coverage command,
  observed edges from agents, lint (orphans, dead ends, depth), the map view
  with paths and next steps, `route_to`; comments on a screen (door A2); walk a
  path, one picture per step, as review evidence from U4.
- **U3 — routine.** A nightly run, off by default per workspace; recapture by
  the files a branch changed; the coverage report; a note in the Inbox.
- **U4 — review.** A Screens tab in a branch's review (door C): before and
  after pictures and the map's diff.
- **U5 — live.** The running app inside the map (door B, served on its own
  local origin); the playground an agent writes as reviewed code.
- **U6 — more apps.** A real app outside COGNIX[WS]; `expo-web` and Electron's
  renderer; native apps, pictures only.
