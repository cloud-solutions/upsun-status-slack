/**
 * State diffing against Workers KV.
 *
 * For each item we store under `<kind>:<id>` a snapshot of:
 *   - status
 *   - updated_at
 *   - last event/timeline entry timestamp (the "freshness" signal)
 *
 * Diff outcome:
 *   - "new"     — no prior state exists in KV
 *   - "updated" — prior state differs in status, updated_at, or last-event timestamp
 *   - "same"    — nothing to post
 *
 * State entries get a 90-day TTL so resolved incidents/events eventually expire.
 */

import type { Incident, IncidentEvent, MaintenanceEvent } from "./upsun";

const KV_TTL_SECONDS = 90 * 24 * 60 * 60;

export type DiffOutcome = "new" | "updated" | "same";

interface StoredState {
  status: string;
  updated_at: string;
  last_event_ts: string | null;
}

function lastTs(entries: IncidentEvent[]): string | null {
  if (entries.length === 0) return null;
  // Don't assume sort order — pick max defensively.
  let max = entries[0]!.timestamp;
  for (const e of entries) {
    if (e.timestamp > max) max = e.timestamp;
  }
  return max;
}

function snapshot(item: Incident | MaintenanceEvent, entries: IncidentEvent[]): StoredState {
  return {
    status: item.status,
    updated_at: item.updated_at,
    last_event_ts: lastTs(entries),
  };
}

function differs(a: StoredState, b: StoredState): boolean {
  return (
    a.status !== b.status ||
    a.updated_at !== b.updated_at ||
    a.last_event_ts !== b.last_event_ts
  );
}

async function diffOne(
  kv: KVNamespace,
  key: string,
  current: StoredState,
): Promise<DiffOutcome> {
  const priorRaw = await kv.get(key);
  if (priorRaw === null) {
    await kv.put(key, JSON.stringify(current), { expirationTtl: KV_TTL_SECONDS });
    return "new";
  }
  let prior: StoredState;
  try {
    prior = JSON.parse(priorRaw) as StoredState;
  } catch {
    // Corrupt entry — treat as new and overwrite.
    await kv.put(key, JSON.stringify(current), { expirationTtl: KV_TTL_SECONDS });
    return "new";
  }
  if (differs(prior, current)) {
    await kv.put(key, JSON.stringify(current), { expirationTtl: KV_TTL_SECONDS });
    return "updated";
  }
  return "same";
}

export function diffIncident(kv: KVNamespace, item: Incident): Promise<DiffOutcome> {
  return diffOne(kv, `incident:${item.id}`, snapshot(item, item.events ?? []));
}

export function diffEvent(kv: KVNamespace, item: MaintenanceEvent): Promise<DiffOutcome> {
  return diffOne(kv, `event:${item.id}`, snapshot(item, item.timeline ?? []));
}
