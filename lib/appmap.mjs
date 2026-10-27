// appmap — the map of an app as an artifact (ADR-0278's contract, v1): its
// screens, each screen's states, every picture with where it came from, and
// the edges between screens. The atlas builds it from a run; an agent
// publishes it as the artifact kind ext:atlas/appmap; this extension's
// process validates every version before it is stored.

export const EDGE_KINDS = ["declared", "inferred", "observed"];
const PROVENANCE = ["commit", "branch", "viewport", "theme", "role", "world"];

// buildAppmap turns one run's manifest into appmap.json.
export function buildAppmap({ app, surfaces, states, shots, run }) {
  const screens = surfaces.map((s) => ({
    id: s.id,
    title: s.title,
    section: s.area || "",
    kind: s.kind || "route",
    route: s.route || "",
    states: (s.states || []).map((st) => {
      const def = states[st] || { world: st, appmap: st };
      const captures = Object.entries(shots)
        .filter(([, x]) => x.surface === s.id && x.state === st)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, x]) => ({
          file,
          thumb: file.replace(/\.png$/, ".webp"),
          theme: x.theme,
          viewport: x.viewport,
          role: x.role || "owner",
          world: def.world,
          commit: x.rev,
          branch: x.branch,
          sha256: x.sha256,
        }));
      const state = { id: def.appmap, name: st, world: def.world, captures };
      if (s.owed) state.owed = s.owed;
      else if (s.broken?.[st]) state.broken = s.broken[st];
      return state;
    }),
  }));
  return { v: 1, app, generated: { at: run.at, commit: run.rev, branch: run.branch, browser: run.browser }, screens, edges: [] };
}

// validateAppmap answers the first problem, or null (invariant 6: every
// capture names its commit, branch, viewport, theme, role and world).
export function validateAppmap(m) {
  if (!m || typeof m !== "object") return "appmap.json holds an object";
  if (m.v !== 1) return "v must be 1";
  if (!m.app || typeof m.app.name !== "string") return "app.name is required";
  if (!Array.isArray(m.screens)) return "screens is a list";
  const ids = new Set();
  for (const s of m.screens) {
    if (!s || typeof s.id !== "string" || !s.id) return "every screen has an id";
    if (ids.has(s.id)) return `screen ${s.id} appears twice`;
    ids.add(s.id);
    if (!Array.isArray(s.states)) return `screen ${s.id}: states is a list`;
    for (const st of s.states) {
      if (!st || typeof st.id !== "string") return `screen ${s.id}: every state has an id`;
      for (const c of st.captures || []) {
        const missing = PROVENANCE.filter((k) => !c[k]);
        if (missing.length) return `screen ${s.id}, state ${st.id}: a capture lacks ${missing.join(", ")}`;
      }
    }
  }
  if (!Array.isArray(m.edges || [])) return "edges is a list";
  for (const e of m.edges || []) {
    if (!ids.has(e.from?.screen) || !ids.has(e.to?.screen)) return "an edge names a screen the map does not have";
    if (!EDGE_KINDS.includes(e.kind)) return `an edge's kind is one of ${EDGE_KINDS.join(", ")}`;
  }
  return null;
}
