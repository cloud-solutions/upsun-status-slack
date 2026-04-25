/**
 * Allowlist matcher for region IDs and component names.
 *
 * An item passes if:
 *   - either allowlist contains "*" (allow all), OR
 *   - any of its region_ids is in the regions allowlist, OR
 *   - any of its components is in the components allowlist.
 *
 * (OR semantics across the two lists, so e.g. "all incidents in de-2" and
 * "all incidents on Grid Hosting anywhere" both work via a single config.)
 */

export interface FilterConfig {
  allowRegions: string[];
  allowComponents: string[];
}

export function shouldPost(
  regionIds: string[],
  componentNames: string[],
  cfg: FilterConfig,
): boolean {
  const allRegions = cfg.allowRegions.includes("*");
  const allComponents = cfg.allowComponents.includes("*");
  if (allRegions || allComponents) return true;
  if (regionIds.some((r) => cfg.allowRegions.includes(r))) return true;
  return componentNames.some((n) => cfg.allowComponents.includes(n));
}

/** Log skipped items so `wrangler tail` reveals real region/component values. */
export function logSkip(
  kind: "incident" | "event",
  id: string,
  regionIds: string[],
  componentNames: string[],
): void {
  const regions = regionIds.join(",") || "(none)";
  const components = componentNames.join(",") || "(none)";
  console.log(`skipped ${kind} ${id}: regions=[${regions}] components=[${components}]`);
}
