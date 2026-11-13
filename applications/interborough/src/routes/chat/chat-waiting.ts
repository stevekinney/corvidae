/**
 * Whether a chat is waiting on its person because of a tool approval, for the status beside the
 * chat's title. The approval card keeps its own words ("Expired before a decision", Ask again);
 * this decides only the header's.
 */
import type { ToolCallEntry } from './tool-activity.ts';

/**
 * Whether an approval holds the chat on its person: one pending now, or one that expired while the
 * run is still parked on input, because the person must still press Ask again or deny it. An
 * expired approval on a run that is no longer waiting (it ended or moved on) holds nothing.
 *
 * @param entries - The tool calls of the chat, across its turns.
 * @param activity - The Bureau's activity for the chat, as `context.data.activity` reports it.
 */
export function approvalHoldsChat(
  entries: Iterable<Pick<ToolCallEntry, 'state'>>,
  activity: 'running' | 'awaiting-input' | 'idle' | undefined,
): boolean {
  for (const entry of entries) {
    if (entry.state === 'needs-you') return true;
    if (entry.state === 'expired' && activity === 'awaiting-input') return true;
  }
  return false;
}
