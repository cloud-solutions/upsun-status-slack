#!/usr/bin/env node
/**
 * Wipes every key from the STATUS_STATE KV namespace, so the next worker run
 * treats every current incident/event as new.
 *
 * Run with: npm run reset-state
 *
 * Requires CLOUDFLARE_API_TOKEN in the environment (same as wrangler deploy).
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINDING = "STATUS_STATE";

function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
}

console.log(`Listing keys in ${BINDING}...`);
const listOut = wrangler(["kv", "key", "list", "--binding", BINDING, "--remote"]);

let items;
try {
  // Wrangler may print a header/log line before the JSON payload; isolate the array.
  const start = listOut.indexOf("[");
  const end = listOut.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no JSON array in output");
  items = JSON.parse(listOut.slice(start, end + 1));
} catch (err) {
  console.error("Could not parse wrangler output:", err.message);
  console.error("Raw output:\n" + listOut);
  process.exit(1);
}

const names = items.map((k) => k.name).filter((n) => typeof n === "string");
if (names.length === 0) {
  console.log("STATUS_STATE is already empty. Nothing to do.");
  process.exit(0);
}

const file = join(tmpdir(), `upsun-slack-keys-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(names));

console.log(`Deleting ${names.length} key(s) from ${BINDING}...`);
try {
  wrangler(
    ["kv", "bulk", "delete", file, "--binding", BINDING, "--remote", "--force"],
    { inherit: true },
  );
} finally {
  try {
    unlinkSync(file);
  } catch {
    /* ignore */
  }
}
console.log("Done. Next scheduled run will re-treat all current items as new.");
