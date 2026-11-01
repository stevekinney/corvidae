/**
 * Whether a tool asks first, for an agent: the one answer the editor marks. An agent file states
 * when a tool asks in `toolApproval` (`always`, `never`, `on-changes`, `blocked`); a tool the file
 * leaves out is `on-changes`, and `on-changes` asks exactly when the catalog's `defaultApproval`
 * for the tool is `ask` (Armorer's tier rule: a tool that changes something, is dangerous or
 * declares nothing). A chat's permission mode can change this at run time; this is what the
 * agent's file says. `never` cannot let through a tool that declares no tier: Armorer never lets a
 * call it cannot classify through unasked, so that tool still asks.
 */
import type { ToolApproval } from './agent-definitions.ts';
import type { PickerTool } from './tool-sources.ts';

/** What happens when the agent calls the tool: it asks first, it runs, or it is refused. */
export type ToolStanding = 'asks-first' | 'runs' | 'blocked';

/** The standing of `tool` for an agent whose file states `approval` for it, or nothing. */
export function standingOf(
  tool: Pick<PickerTool, 'defaultApproval' | 'tier'>,
  approval: ToolApproval | undefined,
): ToolStanding {
  switch (approval) {
    case 'always':
      return 'asks-first';
    case 'never':
      return tool.tier === null ? 'asks-first' : 'runs';
    case 'blocked':
      return 'blocked';
    case 'on-changes':
    case undefined:
      return tool.defaultApproval === 'ask' ? 'asks-first' : 'runs';
  }
}
