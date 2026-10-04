/**
 * Tool selection by name: GLPI_TOOLSETS (named presets, see toolsets.ts),
 * GLPI_TOOLS_INCLUDE / GLPI_TOOLS_EXCLUDE (globs).
 *
 * Selection rule: with no toolset and no include glob, every tool is selected.
 * Otherwise a tool is selected when it belongs to one of the toolsets OR
 * matches an include glob (the two add up). Exclude globs always win.
 *
 * With both API families on, the server has 165 tools; most clients only need
 * a slice of them, and every registered tool costs context in each session.
 * Like the write policy, this wraps `server.registerTool` once instead of
 * touching the call sites.
 */

export interface ToolFilterOptions {
  /** Names matching one of these globs are registered (adds to `inToolsets`). */
  include: RegExp[];
  /** Names matching one of these globs are never registered. */
  exclude: RegExp[];
  /** Membership in the selected toolsets (see toolsets.ts `toolsetMatcher`); absent = no toolset. */
  inToolsets?: (name: string) => boolean;
}

export interface ToolFilterStats {
  registered(): number;
  dropped(): number;
}

/** "glpi_*ticket*, glpi_search" -> anchored regexes (`*` = any run of characters). */
export function parseGlobList(value: string | undefined): RegExp[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((glob) => new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
}

export function isToolSelected(name: string, options: ToolFilterOptions): boolean {
  if (options.exclude.some((re) => re.test(name))) return false;
  const restricted = options.include.length > 0 || options.inToolsets !== undefined;
  if (!restricted) return true;
  return options.include.some((re) => re.test(name)) || (options.inToolsets?.(name) ?? false);
}

export function installToolFilter(server: object, options: ToolFilterOptions): ToolFilterStats {
  const target = server as { registerTool: (name: string, ...rest: unknown[]) => unknown };
  const original = target.registerTool.bind(target);
  let registered = 0;
  let dropped = 0;
  target.registerTool = (name: string, ...rest: unknown[]) => {
    if (!isToolSelected(name, options)) {
      dropped++;
      return undefined;
    }
    registered++;
    return original(name, ...rest);
  };
  return { registered: () => registered, dropped: () => dropped };
}
