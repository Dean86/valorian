/**
 * Demo content — served when no ORIGIN is configured, so the whole demo runs
 * standalone. Ages are relative to "now" so freshness bands stay meaningful.
 * With ORIGIN set, requests proxy through and content age comes from the
 * AGES KV map (stage 6) or DEFAULT_AGE_DAYS.
 */

export interface DemoResource {
  path: string;
  ageDays: number;
  body: string;
}

export const DEMO_RESOURCES: DemoResource[] = [
  { path: "/article/agent-web-charging", ageDays: 2, body: "# The agent web has payments, not charging\n(fresh article — premium rated)" },
  { path: "/article/brm-rating-basics", ageDays: 30, body: "# How telco rating engines work\n(recent article)" },
  { path: "/article/ocs-history", ageDays: 900, body: "# A history of online charging\n(archive article)" },
  { path: "/api/lookup", ageDays: 0, body: '{"result":"BRM error PIN_ERR_BAD_ARG: invalid flist field","source":"meridian-demo-api"}' },
  { path: "/glossary/impact-category", ageDays: 200, body: "# Impact category\nThe rate bucket a charge selector resolves an event into." },
];

export function findDemoResource(path: string): DemoResource | undefined {
  return DEMO_RESOURCES.find((r) => r.path === path);
}

export function contentAgeDays(path: string, defaultAgeDays: number): number {
  return findDemoResource(path)?.ageDays ?? defaultAgeDays;
}

/** In ORIGIN mode, derive content age from the request itself:
 *  /latest → 0 days (freshest); an `end`/`date` query param → age of that
 *  date; else the configured default. This is what lets freshness bands
 *  price real data APIs (current week premium, archive cheap). */
export function contentAgeFromRequest(url: URL, defaultAgeDays: number): number {
  if (url.pathname.endsWith("/latest")) return 0;
  const dateParam = url.searchParams.get("end") ?? url.searchParams.get("date");
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return Math.max(0, Math.floor((Date.now() - Date.parse(dateParam)) / 86_400_000));
  }
  return defaultAgeDays;
}
