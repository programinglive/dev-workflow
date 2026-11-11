/**
 * Which Zettly Draw relation belongs to a session, and whether the session is
 * supposed to have one.
 *
 * The browser dashboard renders the flow from `task_relations_json`; the tablet
 * used to ignore that field entirely, so the owner could not see the plan from
 * the device he actually carries. Keeping the lookup here makes it testable
 * without a React Native runtime.
 */

/** The Zettly Draw relation is the only proof that a Mermaid flow exists. */
export function relasiFlow(session) {
  const relations = Array.isArray(session && session.task_relations_json)
    ? session.task_relations_json
    : [];
  return relations.find((r) => r && r.system === "zettly_draw" && r.id) || null;
}

/** A task without a drawing is a plan the monitor cannot show. */
export function punyaTask(session) {
  return Boolean(String((session && (session.task || session.session_title)) || "").trim());
}

/**
 * A token that changes once per app launch.
 *
 * The tablet cached a 404 for the flow image and never asked again, even after
 * the server started serving it: the URL was identical, so the image loader
 * answered from its failure cache. A per-launch token makes every start a new
 * URL, so a failure cannot outlive the session that caused it, while a running
 * session still reuses the image it already has.
 */
const LAUNCH_TOKEN = Date.now().toString(36);

/** The raster copy the tablet can draw; `<Image>` cannot render SVG. */
export function urlThumbnail(baseUrl, drawingId, token = LAUNCH_TOKEN) {
  const base = String(baseUrl).replace(/\/+$/, "");
  return base + "/api/drawings/" + encodeURIComponent(drawingId) +
    "/thumbnail.png?v=" + encodeURIComponent(token);
}
