/**
 * Upsun status page schema (https://status.upsun.com/llms.txt) and fetchers.
 *
 * Both endpoints return `{ incidents: [...] }` / `{ events: [...] }` JSON.
 * We fetch defensively: any failure or schema surprise returns `[]` and logs.
 */

const INCIDENTS_URL = "https://status.upsun.com/data/incidents.json";
const EVENTS_URL = "https://status.upsun.com/data/events.json";
const FETCH_TIMEOUT_MS = 10_000;

export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved"
  | "postmortem";

export type EventStatus = "scheduled" | "in_progress" | "completed" | "cancelled";

export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

export interface Component {
  name: string;
  status: ComponentStatus;
}

export interface IncidentEvent {
  description: string;
  timestamp: string;
  status?: IncidentStatus;
}

export interface Incident {
  id: string;
  description: string;
  region_ids: string[];
  status: IncidentStatus;
  /** Incidents return objects: `[{name, status}, ...]`. */
  components: Component[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  events: IncidentEvent[];
}

export interface MaintenanceEvent {
  id: string;
  description: string;
  region_ids: string[];
  /**
   * Events return plain strings: `["Grid Hosting", ...]` — different shape from
   * incidents. Schema doc (`llms.txt`) is wrong about this; the live API is the
   * source of truth. Some entries have null/undefined values, hence the union.
   */
  components: (string | null | undefined)[];
  status: EventStatus;
  start_date: string;
  end_date: string;
  planned_duration?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  timeline: IncidentEvent[];
}

/** Extract component names regardless of incident-vs-event shape. */
export function componentNamesOf(
  components: (Component | string | null | undefined)[] | null | undefined,
): string[] {
  if (!Array.isArray(components)) return [];
  const names: string[] = [];
  for (const c of components) {
    if (typeof c === "string" && c.length > 0) names.push(c);
    else if (c && typeof c === "object" && typeof c.name === "string") names.push(c.name);
  }
  return names;
}

async function fetchJson<T>(url: string, root: "incidents" | "events"): Promise<T[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "upsun-slack-worker/0.1 (+cloudflare-workers)" },
    });
    if (!res.ok) {
      console.error(`fetch ${url} returned ${res.status}`);
      return [];
    }
    const body = (await res.json()) as Record<string, unknown>;
    const list = body?.[root];
    if (!Array.isArray(list)) {
      console.error(`fetch ${url}: missing or non-array '${root}' field`);
      return [];
    }
    return list as T[];
  } catch (err) {
    console.error(`fetch ${url} threw`, err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function fetchIncidents(): Promise<Incident[]> {
  return fetchJson<Incident>(INCIDENTS_URL, "incidents");
}

export function fetchEvents(): Promise<MaintenanceEvent[]> {
  return fetchJson<MaintenanceEvent>(EVENTS_URL, "events");
}
