/**
 * Every MCP App the Bureau MCP adapter serves (COR-910): each app's `ui://` resource and the tool
 * metadata that links a tool to it, merged into the one pair the adapter accepts.
 */
import { pendingReviewMount } from './pending-review-resource.ts';
import { runInspectorMount } from './run-inspector-resource.ts';

/** Build every app once and merge their resources and tool metadata. */
export async function mcpAppMounts() {
  const mounts = await Promise.all([runInspectorMount(), pendingReviewMount()]);
  const toolMeta: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const mount of mounts) Object.assign(toolMeta, mount.toolMeta);
  return { resources: mounts.flatMap((mount) => mount.resources), toolMeta };
}
