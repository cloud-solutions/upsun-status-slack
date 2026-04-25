/**
 * Upsun status → Slack worker.
 *
 * scheduled() runs every 5 minutes (per wrangler.jsonc cron). It:
 *   1. fetches incidents.json + events.json
 *   2. filters by ALLOW_REGIONS / ALLOW_COMPONENTS
 *   3. diffs against KV state
 *   4. posts new or status-changed items to Slack
 *
 * fetch() exposes a manual /run trigger gated by the last 8 chars of the
 * webhook URL — handy for one-off testing without waiting for the cron.
 */

import {
  fetchIncidents,
  fetchEvents,
  componentNamesOf,
  type Incident,
  type MaintenanceEvent,
} from "./upsun";
import { shouldPost, logSkip, type FilterConfig } from "./filter";
import { diffIncident, diffEvent, type DiffOutcome } from "./diff";
import { formatIncident, formatEvent, postToSlack, type FormatConfig } from "./slack";

export interface Env {
  STATUS_STATE: KVNamespace;
  SLACK_WEBHOOK_URL: string;
  ALLOW_REGIONS: string[];
  ALLOW_COMPONENTS: string[];
  TIMEZONE: string;
  LOCALE: string;
}

function readFilterConfig(env: Env): FilterConfig {
  // Defensive: if someone deploys with the vars missing, default to "all".
  return {
    allowRegions: Array.isArray(env.ALLOW_REGIONS) ? env.ALLOW_REGIONS : ["*"],
    allowComponents: Array.isArray(env.ALLOW_COMPONENTS) ? env.ALLOW_COMPONENTS : ["*"],
  };
}

function readFormatConfig(env: Env): FormatConfig {
  return {
    timezone: typeof env.TIMEZONE === "string" && env.TIMEZONE ? env.TIMEZONE : "UTC",
    locale: typeof env.LOCALE === "string" && env.LOCALE ? env.LOCALE : "en-US",
  };
}

async function processIncidents(
  env: Env,
  filterCfg: FilterConfig,
  formatCfg: FormatConfig,
  items: Incident[],
): Promise<void> {
  const posts: Promise<void>[] = [];
  for (const item of items) {
    const names = componentNamesOf(item.components);
    if (!shouldPost(item.region_ids ?? [], names, filterCfg)) {
      logSkip("incident", item.id, item.region_ids ?? [], names);
      continue;
    }
    const outcome: DiffOutcome = await diffIncident(env.STATUS_STATE, item);
    if (outcome === "same") continue;
    posts.push(postToSlack(env.SLACK_WEBHOOK_URL, formatIncident(item, outcome, formatCfg)));
  }
  await Promise.all(posts);
}

async function processEvents(
  env: Env,
  filterCfg: FilterConfig,
  formatCfg: FormatConfig,
  items: MaintenanceEvent[],
): Promise<void> {
  const posts: Promise<void>[] = [];
  for (const item of items) {
    const names = componentNamesOf(item.components);
    if (!shouldPost(item.region_ids ?? [], names, filterCfg)) {
      logSkip("event", item.id, item.region_ids ?? [], names);
      continue;
    }
    const outcome: DiffOutcome = await diffEvent(env.STATUS_STATE, item);
    if (outcome === "same") continue;
    posts.push(postToSlack(env.SLACK_WEBHOOK_URL, formatEvent(item, outcome, formatCfg)));
  }
  await Promise.all(posts);
}

async function runPoll(env: Env): Promise<void> {
  const filterCfg = readFilterConfig(env);
  const formatCfg = readFormatConfig(env);
  const [incidents, events] = await Promise.all([fetchIncidents(), fetchEvents()]);
  console.log(`fetched ${incidents.length} incidents, ${events.length} events`);
  await Promise.all([
    processIncidents(env, filterCfg, formatCfg, incidents),
    processEvents(env, filterCfg, formatCfg, events),
  ]);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPoll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      const expected = env.SLACK_WEBHOOK_URL.slice(-8);
      if (url.searchParams.get("key") !== expected) {
        return new Response("unauthorized", { status: 401 });
      }
      await runPoll(env);
      return new Response("ok\n");
    }
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
