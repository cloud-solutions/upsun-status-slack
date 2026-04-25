/**
 * Slack Block Kit message formatting + incoming-webhook delivery.
 *
 * Webhooks can't edit prior messages, so each status change is a brand-new
 * message. That's a deliberate v1 tradeoff (see plan).
 *
 * Timezone and locale are configurable via wrangler.jsonc `vars` and threaded
 * through here as a FormatConfig.
 */

import type { Component, Incident, IncidentEvent, MaintenanceEvent } from "./upsun";
import { componentNamesOf } from "./upsun";
import type { DiffOutcome } from "./diff";

const STATUS_PAGE_URL = "https://status.upsun.com";
const MAX_DESC_LEN = 600;

/** Per-deploy formatting preferences read from `vars` in wrangler.jsonc. */
export interface FormatConfig {
  /** IANA timezone, e.g. "Europe/Zurich", "UTC", "America/New_York". */
  timezone: string;
  /** BCP-47 locale, e.g. "de-CH", "en-US", "en-GB". */
  locale: string;
}

interface Block {
  type: string;
  [key: string]: unknown;
}

interface SlackPayload {
  text: string;
  blocks: Block[];
}

// --- formatting helpers --------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Full date+time with timezone abbreviation, in the configured locale + TZ. */
function fmtTime(iso: string, cfg: FormatConfig): string {
  const d = new Date(iso);
  if (isNaN(d.valueOf())) return iso;
  return new Intl.DateTimeFormat(cfg.locale, {
    timeZone: cfg.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(d);
}

/** Compact maintenance window. Same calendar-day in TZ → single date + two times. */
function fmtWindow(
  startIso: string,
  endIso: string,
  duration: string | undefined,
  cfg: FormatConfig,
): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const dur = duration ? ` (${duration})` : "";
  if (isNaN(s.valueOf()) || isNaN(e.valueOf())) return `${startIso} → ${endIso}${dur}`;

  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat(cfg.locale, {
      timeZone: cfg.timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);

  if (dayKey(s) === dayKey(e)) {
    const endTime = new Intl.DateTimeFormat(cfg.locale, {
      timeZone: cfg.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(e);
    return `${fmtTime(startIso, cfg)} → ${endTime}${dur}`;
  }
  return `${fmtTime(startIso, cfg)} → ${fmtTime(endIso, cfg)}${dur}`;
}

function latestEntry(entries: IncidentEvent[]): IncidentEvent | undefined {
  if (entries.length === 0) return undefined;
  let latest = entries[0]!;
  for (const x of entries) {
    if (x.timestamp > latest.timestamp) latest = x;
  }
  return latest;
}

function regionsLine(regions: string[]): string {
  return regions.length ? regions.join(", ") : "(none)";
}

function incidentComponentsLine(components: Component[]): string {
  if (!Array.isArray(components) || components.length === 0) return "(none)";
  const parts: string[] = [];
  for (const c of components) {
    if (c && typeof c.name === "string") parts.push(`${c.name} — ${c.status}`);
  }
  return parts.length ? parts.join(", ") : "(none)";
}

function eventComponentsLine(components: (string | null | undefined)[]): string {
  const names = componentNamesOf(components);
  return names.length ? names.join(", ") : "(none)";
}

// --- header selection ----------------------------------------------------

const INCIDENT_TERMINAL: ReadonlySet<string> = new Set(["resolved", "postmortem"]);
const EVENT_TERMINAL: ReadonlySet<string> = new Set(["completed", "cancelled"]);

function incidentHeader(item: Incident, outcome: DiffOutcome): { emoji: string; text: string } {
  if (item.status === "resolved" || item.status === "postmortem") {
    return { emoji: ":white_check_mark:", text: "Incident resolved" };
  }
  if (outcome === "new") return { emoji: ":rotating_light:", text: "New incident" };
  return { emoji: ":warning:", text: "Incident update" };
}

function eventHeader(
  item: MaintenanceEvent,
  outcome: DiffOutcome,
): { emoji: string; text: string } {
  if (item.status === "completed") {
    return { emoji: ":white_check_mark:", text: "Maintenance completed" };
  }
  if (item.status === "cancelled") {
    return { emoji: ":no_entry_sign:", text: "Maintenance cancelled" };
  }
  if (outcome === "new") return { emoji: ":wrench:", text: "Planned maintenance scheduled" };
  return { emoji: ":hammer_and_wrench:", text: "Maintenance update" };
}

// --- block assembly ------------------------------------------------------

function buildBlocks(
  headline: string,
  emoji: string,
  title: string,
  bodyDesc: string,
  contextFields: { label: string; value: string }[],
  includeButton: boolean,
): SlackPayload {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${title}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headline}*\n${truncate(bodyDesc, MAX_DESC_LEN)}` },
    },
    {
      type: "context",
      elements: contextFields.map((f) => ({
        type: "mrkdwn",
        text: `*${f.label}:* ${f.value}`,
      })),
    },
  ];
  if (includeButton) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open status page" },
          url: STATUS_PAGE_URL,
        },
      ],
    });
  }
  return { text: `${title}: ${headline}`, blocks };
}

export function formatIncident(
  item: Incident,
  outcome: DiffOutcome,
  cfg: FormatConfig,
): SlackPayload {
  const { emoji, text } = incidentHeader(item, outcome);
  const latest = latestEntry(item.events ?? []);
  const body = latest?.description ?? item.description;
  const includeButton = !INCIDENT_TERMINAL.has(item.status);
  return buildBlocks(
    item.description,
    emoji,
    text,
    body,
    [
      { label: "Status", value: item.status },
      { label: "Regions", value: regionsLine(item.region_ids) },
      { label: "Components", value: incidentComponentsLine(item.components ?? []) },
      { label: "Updated", value: fmtTime(item.updated_at, cfg) },
    ],
    includeButton,
  );
}

export function formatEvent(
  item: MaintenanceEvent,
  outcome: DiffOutcome,
  cfg: FormatConfig,
): SlackPayload {
  const { emoji, text } = eventHeader(item, outcome);
  const latest = latestEntry(item.timeline ?? []);
  const body = latest?.description ?? item.description;
  const includeButton = !EVENT_TERMINAL.has(item.status);
  return buildBlocks(
    item.description,
    emoji,
    text,
    body,
    [
      { label: "Status", value: item.status },
      {
        label: "Window",
        value: fmtWindow(item.start_date, item.end_date, item.planned_duration, cfg),
      },
      { label: "Regions", value: regionsLine(item.region_ids) },
      { label: "Components", value: eventComponentsLine(item.components ?? []) },
    ],
    includeButton,
  );
}

// --- delivery ------------------------------------------------------------

export async function postToSlack(webhookUrl: string, payload: SlackPayload): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    if (res.status >= 500 && attempt === 1) {
      console.error(`slack webhook ${res.status}, retrying once`);
      continue;
    }
    const detail = await res.text().catch(() => "(no body)");
    console.error(`slack webhook failed: ${res.status} ${detail}`);
    return;
  }
}
