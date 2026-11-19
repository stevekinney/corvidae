// The coordinator context fence: `Agent`, `Workflow` and `start_session` are denied for a leased
// coordinator whose context is above {@link contextFenceTokens}, until it compacts. Decided from
// `scripts/host-sessions.ts` `handleHookEvent` with the other session fences
// (`scripts/chef/session-fences.ts`). A call made by a subagent (the payload carries an `agent_id`)
// and a session without a live lease marker are never fenced (owner decision, 2026-11-13). A
// transcript that cannot be read fails open, with the reason logged.

import { deny, failOpen, type FenceOutput, type LeasedSession } from './session-fences.ts';
import { contextOf, readTranscript } from './transcript-usage.ts';

/** The context size above which a leased coordinator dispatches nothing until it compacts. */
export const contextFenceTokens = 200_000;

/** The tools a leased coordinator's context fence covers. */
export const fencedToolNames: ReadonlySet<string> = new Set([
  'Agent',
  'Workflow',
  'mcp__ccd_session__start_session',
]);

/** The context size of a transcript's last model call, or why it could not be read. */
export function currentContext(transcriptPath: string): number | string {
  try {
    const usage = readTranscript(transcriptPath);
    if (usage === undefined) return 'the transcript is in no known format';
    const last = usage.calls.at(-1);
    return last === undefined ? 0 : contextOf(last);
  } catch (error) {
    return `the transcript could not be read (${String(error)})`;
  }
}

/**
 * Denies a fenced tool for a leased coordinator above the fence, until it compacts. The last model
 * call's context is measured, not a sum or a peak, so a compaction lifts the fence.
 */
export function contextFenceDecision(options: {
  leased: LeasedSession | undefined;
  agentId: string;
  transcriptPath: string;
  limit?: number;
}): FenceOutput | undefined {
  if (options.leased === undefined || options.agentId !== '') return undefined;
  if (options.transcriptPath === '') return failOpen('the payload has no transcript_path');
  const size = currentContext(options.transcriptPath);
  if (typeof size === 'string') return failOpen(size);
  const limit = options.limit ?? contextFenceTokens;
  if (size <= limit) return undefined;
  return deny(
    `This coordinator's context is ${size.toLocaleString('en-US')} tokens, above the ${limit.toLocaleString('en-US')} limit for a leased session. Bring the note up to date, then compact (\`/compact\`) before dispatching again; the fence lifts once the context is below the limit. Every call in a context this large pays for all of it.`,
  );
}
