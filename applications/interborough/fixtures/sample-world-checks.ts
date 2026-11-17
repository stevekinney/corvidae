/**
 * The sample world's check results outside its goals (COR-2114, the Checks page): the guardrails
 * that blocked, warned, sanitized, redacted or tripped a run, a scorer's scores, and a chat a
 * guardrail flagged, across Oct 29 and Oct 30. The goals' own verdicts are the story's real ones
 * (`sample-world-history.ts`); a guardrail, a scorer and a taint need a model that misbehaves, which
 * the stub provider does not, so each is written the way Bureau writes it, to the trail and the
 * session, at the time the story gives it.
 *
 * There are more than fifty rows in all, so the Checks page has a second page behind Load more, and
 * at least one row of each kind and of every outcome a person is shown a word for.
 *
 * @module sample-world-checks
 */

import { central, type SessionContext } from './sample-world-host.ts';
import { SAMPLE_WORLD_THREADS } from './sample-world-records.ts';

/** The first check of the story, Oct 29 at 9:00 AM Central. */
const FIRST_GUARDRAIL = central('2026-10-29T09:00:00', '-05:00');

/** How far apart the guardrail rows are: a quarter of an hour. */
const GUARDRAIL_STEP_MILLISECONDS = 15 * 60_000;

/** How many guardrail rows the story holds, which with the others take the list past one page of fifty. */
export const SAMPLE_WORLD_GUARDRAIL_ROWS = 56;

/** The guardrails the filler rows come from, with what each does, in turn. */
const GUARDRAILS = [
  { name: 'pii-input', action: 'block', category: 'pii', phase: 'input' },
  { name: 'secrets-output', action: 'redact', category: 'secret', phase: 'output' },
  {
    name: 'prompt-injection-input',
    action: 'sanitize',
    category: 'prompt-injection',
    phase: 'input',
  },
  { name: 'toxicity-output', action: 'warn', category: 'toxicity', phase: 'output' },
] as const;

/** The moments of the rows that are not filler. */
export const SAMPLE_WORLD_CHECK_TIMES = {
  spendLimitTripped: central('2026-10-30T08:40:00', '-05:00'),
  injectionFlagged: central('2026-10-30T08:02:00', '-05:00'),
  politenessScored: central('2026-10-30T09:12:00', '-05:00'),
  accuracyScored: central('2026-10-30T09:30:00', '-05:00'),
  groundednessScored: central('2026-10-30T10:15:00', '-05:00'),
} as const;

/** What a scorer's record carries besides its outcome, as the sampler writes it. */
function scorerDetail(
  agent: string,
  name: string,
  version: string,
  outcome: string,
  score: number | undefined,
): Record<string, unknown> {
  return {
    runKind: 'agent',
    definitionId: agent,
    definitionVersion: null,
    judgedBy: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
    judgeName: name,
    judgeVersion: version,
    judgeDigest: `digest-${name}-${version}`,
    sampleRate: 1,
    outcome,
    ...(score === undefined ? {} : { score }),
    message: `${name} said ${outcome}`,
    durationMs: 1_200,
  };
}

/**
 * Writes the check results the story holds beside its goals' verdicts: every guardrail and scorer
 * record against a goal attempt's run (so a row's link opens a run the host knows), and the taint of
 * the billing chat, whose `updatedAt` the write leaves where it was.
 */
export async function checksRecorded(context: SessionContext): Promise<void> {
  const { host, runtime } = context;
  const trail = host.bureau.internals.auditTrail;
  const sessions = host.bureau.internals.sessionStore;
  if (trail === undefined || sessions === undefined) {
    throw new Error('The sample world needs a Bureau that keeps an audit trail and sessions.');
  }
  const goals = await host.bureau.goals.list();
  const runs = goals.flatMap((goal) =>
    goal.attempts.map((attempt) => ({ runId: attempt.runId, agent: goal.objective.agentName })),
  );
  const [first, second] = runs;
  if (first === undefined || second === undefined) {
    throw new Error('The sample world needs the goals’ attempts before it can record checks.');
  }
  const runOf = (index: number) => (index % 2 === 0 ? first : second);

  for (let index = 0; index < SAMPLE_WORLD_GUARDRAIL_ROWS; index += 1) {
    const guardrail = GUARDRAILS[index % GUARDRAILS.length]!;
    await trail.record({
      runId: runOf(index).runId,
      type: 'run.guardrail',
      timestampMs: FIRST_GUARDRAIL + index * GUARDRAIL_STEP_MILLISECONDS,
      strict: true,
      detail: {
        step: 0,
        guardrailName: guardrail.name,
        category: guardrail.category,
        phase: guardrail.phase,
        confidence: 0.9,
        action: guardrail.action,
      },
    });
  }
  const times = SAMPLE_WORLD_CHECK_TIMES;
  await trail.record({
    runId: second.runId,
    type: 'run.tripwire',
    timestampMs: times.spendLimitTripped,
    strict: true,
    detail: {
      step: 1,
      guardrailName: 'spend-limit',
      category: 'spend',
      phase: 'output',
      confidence: 1,
    },
  });
  for (const [at, agent, name, version, outcome, score] of [
    [times.politenessScored, 'assistant', 'politeness', '2', 'pass', 0.82],
    [times.accuracyScored, 'tool-runner', 'accuracy', '1', 'fail', 0.31],
    [times.groundednessScored, 'tool-runner', 'groundedness', '1', 'error', undefined],
  ] as const) {
    await trail.record({
      runId: agent === 'assistant' ? first.runId : second.runId,
      type: 'scorer.recorded',
      timestampMs: at,
      strict: true,
      detail: scorerDetail(agent, name, version, outcome, score),
    });
  }

  // The billing chat is flagged: the Oct 29 chat a restart ended, which no specification continues,
  // so a taint (which narrows what a later run of the session may do) changes nothing a spec reads.
  // Writing its metadata refreshes its `updatedAt` from the clock, so the clock is held at the chat's
  // own `updatedAt` for the write and the chat stays where it was listed.
  const billing = await sessions.load(SAMPLE_WORLD_THREADS.billing);
  if (billing === undefined) throw new Error('The sample world has no billing chat to flag.');
  const resumedAt = runtime.clock.now();
  runtime.setTime(Date.parse(billing.updatedAt));
  try {
    await sessions.updateMetadata(billing.id, {
      guardrailTaint: {
        category: 'prompt-injection',
        detector: 'prompt-injection-input',
        provenance: 'user-input',
        confidence: 0.97,
        at: times.injectionFlagged,
        runId: first.runId,
      },
    });
  } finally {
    runtime.setTime(resumedAt);
  }
}
