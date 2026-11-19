// Mechanisms the chef charter used to state as prose, decided here and called from
// `scripts/host-sessions.ts` `handleHookEvent` before it records or admits anything (hooks of one
// event run in parallel, so a separate hook could deny after the place was taken or the worker's
// stop recorded). Each decision is a function of its input; `host-sessions.ts` reads the lease
// marker (item 6) and passes in whether it is live.
//
// - A `chef-worker` `SubagentStop` is blocked, with the reason, until `reports/<issue>.json` under
//   the coordinator's execution state is valid (`report-schema.ts`), names the brief version now on
//   disk, and lists every correction entry for the branch. Blocking lets the worker write it.
//   After {@link stopBlockLimit} blocks of one agent the stop goes through with a logged reason, so
//   a worker that cannot write the file is not trapped.
// - `AskUserQuestion` is denied for a session holding a live lease marker; unleased sessions
//   (`/groom`, `/create-task`) keep it.
// - The context fence on a leased coordinator is `scripts/chef/context-fence.ts`.
//
// Every decision that cannot read its own input fails open and says why in `systemMessage`; only
// the refusals above deny.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  briefStemIn,
  briefVersionIn,
  unreadCorrections,
  validateReport,
  type WorkerReport,
} from './report-schema.ts';
import { readCorrections, reportPathOf } from './report.ts';

/** How many times one worker's stop is blocked before it goes through with a logged reason. */
export const stopBlockLimit = 3;

export type FenceOutput = {
  readonly systemMessage?: string;
  readonly decision?: 'block';
  readonly reason?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'deny';
    readonly permissionDecisionReason: string;
  };
};

export function deny(reason: string): FenceOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function failOpen(reason: string): FenceOutput {
  return { systemMessage: `session-fences: ${reason}; not enforced.` };
}

/** What a live lease marker says about the session; `undefined` when the session is unleased. */
export type LeasedSession = { readonly project: string; readonly run: string };

/** Denies `AskUserQuestion` for a leased session: a dialog nobody answers froze a coordinator 21 hours. */
export function questionDecision(leased: LeasedSession | undefined): FenceOutput | undefined {
  if (leased === undefined) return undefined;
  return deny(
    `This session holds the coordinator lease for ${leased.project} (run ${leased.run}), and a leased session asks no blocking question: the owner may not be at the keyboard, and a dialog nobody answers stops the run. Decide with the brief and the note, or return needs-decision with the options, and carry on with other work.`,
  );
}

function stopBlock(reason: string): FenceOutput {
  return { decision: 'block', reason };
}

function blockCount(stateDirectory: string, agentId: string): string {
  return join(stateDirectory, 'reports', '.stop-blocks', agentId.replaceAll(/[^\w-]/g, '_'));
}

function bumpBlocks(stateDirectory: string, agentId: string): number {
  const path = blockCount(stateDirectory, agentId);
  let count = 0;
  try {
    count = Number(readFileSync(path, 'utf8')) || 0;
  } catch {
    count = 0;
  }
  mkdirSync(join(stateDirectory, 'reports', '.stop-blocks'), { recursive: true });
  writeFileSync(path, String(count + 1));
  return count + 1;
}

/** Why a worker's report does not yet let it stop, or `undefined` when it does. */
function reportProblems(options: {
  stem: string;
  stateDirectory: string;
  briefsDirectory: string;
}): string[] | undefined {
  const { stem, stateDirectory, briefsDirectory } = options;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reportPathOf(stateDirectory, stem), 'utf8'));
  } catch {
    return [`there is no readable report at ${reportPathOf(stateDirectory, stem)}`];
  }
  const checked = validateReport(raw);
  if (!checked.ok) return checked.errors;
  const report: WorkerReport = checked.report;
  const problems: string[] = [];
  if (report.issue !== stem) problems.push(`issue is ${stem}, not ${report.issue}`);
  let current: string | undefined;
  try {
    current = briefVersionIn(readFileSync(join(briefsDirectory, `${stem}.md`), 'utf8'));
  } catch {
    current = undefined;
  }
  if (current !== undefined && current !== report.briefVersion)
    problems.push(
      `the brief was amended after you read it (version ${current}, you read ${report.briefVersion}): re-read tmp/chef/briefs/${stem}.md and the corrections, and report again`,
    );
  const unread = unreadCorrections(readCorrections(stateDirectory, stem), report);
  if (unread.length > 0)
    problems.push(
      `corrections ${unread.map((entry) => entry.id).join(', ')} are unread (${unread.map((entry) => entry.text).join(' | ')}): act on them and list their ids in correctionsRead`,
    );
  return problems.length === 0 ? undefined : problems;
}

/**
 * Blocks a `chef-worker` stop without a valid report. The worker's issue is the brief stem named in
 * its dispatch prompt (the first line of its transcript); with none, there is nothing to look for
 * and the stop goes through with a logged reason.
 */
export function workerStopDecision(options: {
  agentType: string;
  agentId: string;
  transcriptPath: string;
  stateDirectory: string | undefined;
  briefsDirectory: string | undefined;
}): FenceOutput | undefined {
  if (options.agentType !== 'chef-worker') return undefined;
  const { stateDirectory, briefsDirectory } = options;
  if (stateDirectory === undefined || briefsDirectory === undefined)
    return failOpen('the main checkout could not be found, so no report was required');
  let transcript: string;
  try {
    transcript = readFileSync(options.transcriptPath, 'utf8');
  } catch {
    return failOpen('the worker transcript could not be read, so no report was required');
  }
  const stem = briefStemIn(transcript);
  if (stem === undefined)
    return failOpen(
      'the worker prompt names no tmp/chef/briefs/<issue>.md, so no report was required',
    );
  const problems = reportProblems({ stem, stateDirectory, briefsDirectory });
  if (problems === undefined) return undefined;
  const blocks = bumpBlocks(stateDirectory, options.agentId === '' ? stem : options.agentId);
  if (blocks > stopBlockLimit)
    return failOpen(
      `the stop of the worker for ${stem} was blocked ${stopBlockLimit} times (${problems.join('; ')})`,
    );
  return stopBlock(
    `You cannot stop yet: the report for ${stem} is not valid.\n${problems.map((problem) => `- ${problem}`).join('\n')}\nWrite {head, checks, status: "READY"|"BLOCKED", reason?, criteria: [{id, status: "met-on-main"|"met-on-branch"|"not-met"|"needs-decision", evidence}], correctionsRead: [ids]} to a file in your scratch directory and run \`bun scripts/chef/report.ts write ${stem} --file <that file>\`. It writes the report under the coordinator's execution state and the ledger documentation/criteria-ledger/${stem}.json, which you commit and push. head is the commit you checked; checks is the focused-checks result line.`,
  );
}
