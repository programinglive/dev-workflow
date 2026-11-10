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

/** The raster copy the tablet can draw; `<Image>` cannot render SVG. */
export function urlThumbnail(baseUrl, drawingId) {
  return String(baseUrl).replace(/\/+$/, "") + "/api/drawings/" + encodeURIComponent(drawingId) + "/thumbnail.png";
}
