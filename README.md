# Upsun Status → Slack

A small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that polls
[Upsun's status page](https://status.upsun.com) every 5 minutes and posts new or
changed incidents and planned maintenances to a Slack channel — filtered by the
regions and components you actually care about.

[Upsun](https://upsun.com) (Platform.sh's next-gen PaaS) does not natively
integrate with Slack or expose an outbound webhook for status changes. They do
publish two stable JSON feeds though, which this worker consumes:

- `https://status.upsun.com/data/incidents.json`
- `https://status.upsun.com/data/events.json`

## What you get

- One message per new incident, planned maintenance, or status change.
- Filter by region (`ch-1.platform.sh`, `de-2.platform.sh`, `core-systems`, …) and/or
  component name (`Grid Hosting`, `API`, `Console`).
- Times rendered in your timezone with your locale (default UTC + en-US, configurable).
- No servers, no daemons. Cloudflare runs it on a cron trigger.
- Free tier comfortable: ~8.6k worker invocations/month, well under the 100k/day limit.

## Architecture

```
        Cloudflare Cron (*/5 * * * *)
                    │
                    ▼
              Worker.scheduled()
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    incidents.json        events.json
          │                   │
          └─────── filter ────┘
                    │
              KV state diff
              (already-seen?)
                    │
                    ▼
        Slack incoming webhook
```

State is stored in a Cloudflare Workers KV namespace (`STATUS_STATE`). Each
incident/event id is keyed against `{status, updated_at, last_event_ts}` with a
90-day TTL so resolved items eventually expire.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine).
- A Slack workspace where you can create an app + incoming webhook.
- Node.js 18+ and npm.

## Setup

### 1. Clone, install, copy the config template

```sh
git clone <repo-url>
cd upsun-status-slack
npm install
cp wrangler.jsonc.example wrangler.jsonc
```

`wrangler.jsonc` is gitignored — it's your local config. The `.example` file is
the committed template.

### 2. Authenticate Wrangler with Cloudflare

The reliable way is an API token (the OAuth `wrangler login` flow can be flaky):

1. Visit <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   pick the **Edit Cloudflare Workers** template → **Continue** → **Create Token**.
2. Copy the token, then in your shell:

   ```sh
   export CLOUDFLARE_API_TOKEN=<your-token>
   ```

   Add to `~/.zshrc` / `~/.bashrc` to persist across shells.

### 3. Create the KV namespace

```sh
npx wrangler kv namespace create STATUS_STATE
```

Paste the returned id into `wrangler.jsonc` (replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`).

### 4. Create a Slack app and incoming webhook

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. "Upsun Status"), pick your workspace.
3. Sidebar → **Incoming Webhooks** → toggle on → **Add New Webhook to Workspace**
   → pick the target channel → **Allow** → copy the webhook URL.

The app stays private to your workspace — you don't publish it to the Slack App Directory.

### 5. Store the webhook URL as a Cloudflare secret

```sh
npx wrangler secret put SLACK_WEBHOOK_URL
# paste the URL when prompted
```

Wrangler v4 requires the Worker to exist before setting a secret. If it doesn't
yet, wrangler will offer to create a placeholder Worker — answer **Y**.

### 6. Configure regions, components, timezone, locale

Edit `vars` in `wrangler.jsonc`:

```jsonc
"vars": {
  "ALLOW_REGIONS": ["core-systems", "ch-1.platform.sh", "de-2.platform.sh"],
  "ALLOW_COMPONENTS": [],
  "TIMEZONE": "Europe/Zurich",
  "LOCALE": "de-CH"
}
```

- **`ALLOW_REGIONS`** / **`ALLOW_COMPONENTS`** — `["*"]` means "allow all on this
  axis"; `[]` means "match nothing on this axis." An item posts if **any** of
  its regions matches `ALLOW_REGIONS` **or any** of its components matches
  `ALLOW_COMPONENTS`. Set components to `[]` if you want region-only filtering.
- **`TIMEZONE`** — any [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
  (e.g. `Europe/Zurich`, `UTC`, `America/New_York`).
- **`LOCALE`** — any BCP-47 locale tag (e.g. `de-CH`, `en-US`, `en-GB`).
  Affects month/day order and the timezone-abbreviation language. Times are
  always 24-hour.

If you don't yet know what region IDs your provider uses, leave `ALLOW_REGIONS`
as `["*"]` for the first deploy and read `npx wrangler tail` skip-logs after a
few cron ticks to see what's actually appearing — then prune.

### 7. Deploy

```sh
npx wrangler deploy
```

The worker starts running on its 5-minute cron immediately. First scheduled run
will treat all currently-listed incidents/events as new — see [First-deploy
gotcha](#first-deploy-gotcha) below if you want to suppress that initial burst.

## Operating it

- **Watch logs**: `npx wrangler tail`
- **Trigger manually** (without waiting for cron): your worker exposes a
  `/run?key=<last-8-chars-of-webhook-URL>` endpoint:
  ```sh
  curl "https://upsun-status-slack.<your-subdomain>.workers.dev/run?key=<last-8-chars>"
  ```
- **Reset state** (re-treat all current items as new):
  ```sh
  npm run reset-state
  ```
- **Update config**: edit `wrangler.jsonc`, then `npx wrangler deploy`.

## First-deploy gotcha

The very first scheduled run sees an empty KV and treats every currently-listed
incident and event as "new", posting a burst (typically a few dozen messages,
since most status pages keep a few months of history). It's a one-time event;
subsequent ticks stay quiet until something actually changes.

For most setups, just accept the burst. If you really want to suppress it,
temporarily comment out the `postToSlack(...)` calls in `src/index.ts`, run
`npx wrangler deploy`, trigger once via the `/run` endpoint to populate KV,
then uncomment and redeploy.

## Project layout

```
.
├── src/
│   ├── index.ts          scheduled() entry + /run manual-trigger fetch handler
│   ├── upsun.ts          typed fetchers for incidents.json + events.json
│   ├── filter.ts         region/component allowlist matcher + skip-logger
│   ├── diff.ts           KV state comparison → "new" / "updated" / "same"
│   └── slack.ts          Block Kit formatter + webhook POST with retry
├── scripts/
│   └── reset-state.mjs   wipes all KV state
├── wrangler.jsonc.example   template (committed)
├── wrangler.jsonc           your config (gitignored)
├── .dev.vars.example        local-dev secrets template
├── package.json
├── tsconfig.json
└── LICENSE
```

## Limitations and design choices

- **Single channel only**: incoming webhooks are 1:1 with channels. Routing
  different regions to different channels would require switching to a Slack
  bot token and `chat.postMessage` — a deliberate v1 simplification.
- **Each status change is a new message**: webhooks can't edit prior posts.
  A bot-token rewrite could thread updates under the original incident message.
- **5-minute polling latency**: alerts land within ~5 min of the source. Not
  appropriate as a primary on-call paging path; this is a Slack-channel digest,
  not PagerDuty.
- **Tightly coupled to Upsun's status page schema**: if Upsun changes the JSON
  shape, this worker breaks. The `events.json` schema in particular differs
  from `incidents.json` (`components` is `string[]` vs `Component[]`) — see
  `src/upsun.ts` for the type definitions.

## License

[MIT](LICENSE) — Copyright © 2026 Bright Answer OÜ.

## Contributing

Issues and PRs welcome. This is a small project; please open an issue first if
you want to make a substantial change.
