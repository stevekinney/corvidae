/**
 * Where a tool comes from, for the editor's tool picker: the catalog says only `host` or `bureau`
 * (`bureau.agents.catalog`), but a tool a saved tool source loads (an MCP server or an OpenAPI
 * service, `src/host/tool-source-manager.ts`) is named `<id>__<tool>` under that source's
 * identifier, which is what the host itself reads to say which agent files a source's removal
 * breaks. So the group of a host tool is the identifier before its first `__`, and a host tool
 * whose name has none is the host's own.
 *
 * The prefix is a naming convention, not a field: a host plugin's tool that happens to be named
 * `a__b` reads as a source `a`. That only moves the tool to another heading in the picker; the
 * tool, its name and what a save writes are the same.
 */
import type { AgentCatalog } from './agent-definitions.ts';

/** One tool as the catalog lists it. */
export type PickerTool = AgentCatalog['tools'][number];

/** The separator between a saved tool source's identifier and a tool's own name. */
export const TOOL_SOURCE_SEPARATOR = '__';

/** The kinds of place a tool comes from. */
export type ToolSourceKind = 'bureau' | 'host' | 'saved';

/** The place a tool comes from. */
export type ToolOrigin = {
  /** Unique among the origins: `bureau`, `host`, or `saved:<identifier>`. */
  readonly key: string;
  /** Whether the tool is Bureau's, the host's own, or a saved source's. */
  readonly kind: ToolSourceKind;
  /** The saved source's identifier for a `saved` origin, otherwise `undefined`. */
  readonly sourceId: string | undefined;
};

/** The origin of a tool. */
export function originOf(tool: Pick<PickerTool, 'name' | 'source'>): ToolOrigin {
  if (tool.source === 'bureau') return { key: 'bureau', kind: 'bureau', sourceId: undefined };
  const separator = tool.name.indexOf(TOOL_SOURCE_SEPARATOR);
  if (separator > 0 && separator + TOOL_SOURCE_SEPARATOR.length < tool.name.length) {
    const sourceId = tool.name.slice(0, separator);
    return { key: `saved:${sourceId}`, kind: 'saved', sourceId };
  }
  return { key: 'host', kind: 'host', sourceId: undefined };
}

/** The tools of one origin, in the order the catalog lists them. */
export type ToolGroup = {
  /** Where every tool of the group comes from. */
  readonly origin: ToolOrigin;
  /** The group's tools. */
  readonly tools: readonly PickerTool[];
};

const KIND_ORDER: Readonly<Record<ToolSourceKind, number>> = { bureau: 0, host: 1, saved: 2 };

/**
 * The tools grouped by origin: Bureau's, then the host's own, then each saved source by
 * identifier. A group with no tool is not listed.
 */
export function groupByOrigin(tools: readonly PickerTool[]): readonly ToolGroup[] {
  const groups = new Map<string, { origin: ToolOrigin; tools: PickerTool[] }>();
  for (const tool of tools) {
    const origin = originOf(tool);
    const group = groups.get(origin.key);
    if (group === undefined) groups.set(origin.key, { origin, tools: [tool] });
    else group.tools.push(tool);
  }
  return [...groups.values()].sort(
    (left, right) =>
      KIND_ORDER[left.origin.kind] - KIND_ORDER[right.origin.kind] ||
      (left.origin.sourceId ?? '').localeCompare(right.origin.sourceId ?? ''),
  );
}

/**
 * Whether a tool answers a search: the text appears, ignoring case, in its name, its description
 * or its source's identifier. An empty search matches every tool.
 */
export function matchesSearch(tool: PickerTool, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  const origin = originOf(tool);
  return [tool.name, tool.shortDescription ?? '', tool.description, origin.sourceId ?? ''].some(
    (text) => text.toLowerCase().includes(needle),
  );
}
