export const meta = {
  name: 'answer-threads',
  description:
    'One review round for a chef pull request: triage unresolved threads, fix and answer them, push once. Never merges.',
  phases: ['triage', 'answer'],
};

// args: { pr, worktree, round }. AGENTS.md "Review guidelines" caps review at three rounds and
// asks for one push per round. This workflow never merges; the coordinator delivers.

const ROUND_CAP = 3;

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          line: { type: 'string' },
          body: { type: 'string' },
          triage: { type: 'string', enum: ['fix', 'decline', 'track'] },
        },
        required: ['id', 'triage'],
      },
    },
  },
  required: ['threads'],
};

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    round: { type: 'number' },
    answered: { type: 'array', items: { type: 'string' } },
    fixedHead: { type: 'string' },
    open: { type: 'array', items: { type: 'string' } },
  },
  required: ['round', 'answered', 'fixedHead', 'open'],
};

const pr = args && args.pr;
const worktree = args && args.worktree;
const round = Number(args && args.round);

if (!pr || !worktree || !Number.isInteger(round) || round < 1) {
  log('args must be { pr, worktree, round } with round a positive integer');
  return { round: round || 0, answered: [], fixedHead: null, open: [], error: 'invalid args' };
}
if (round > ROUND_CAP) {
  log(
    `refusing round ${round}: review is capped at ${ROUND_CAP} rounds; collect leftovers into one follow-up issue`,
  );
  return { round, answered: [], fixedHead: null, open: [], error: `round above ${ROUND_CAP}` };
}

phase('triage');
log(`PR ${pr}: reading unresolved threads for round ${round}`);
const triaged = await agent(
  [
    `Read the unresolved review threads of pull request ${pr} with \`bun scripts/chef/review-threads.ts list --pr ${pr} --unresolved --json\`, run from ${worktree}. Invoke no skills. Make no GitHub or Linear writes.`,
    'Triage: fix (a real defect in a line this pull request changed, or a one-way-door defect), decline (nit, out of scope, contrived, or contradicts a recorded decision), track (real but belongs to another issue).',
    'Return every thread with id, path, line, body, triage.',
  ].join('\n'),
  {
    label: `triage PR ${pr}`,
    phase: 'triage',
    schema: TRIAGE_SCHEMA,
    model: 'haiku',
    effort: 'low',
  },
);
if (triaged === null) {
  log(`PR ${pr}: triage failed`);
  return { round, answered: [], fixedHead: null, open: [], error: 'triage failed' };
}
if (triaged.threads.length === 0) {
  log(`PR ${pr}: no unresolved threads`);
  return { round, answered: [], fixedHead: null, open: [] };
}
log(
  `PR ${pr}: ${triaged.threads.length} threads (${triaged.threads.filter((t) => t.triage === 'fix').length} to fix)`,
);

phase('answer');
const answered = await agent(
  [
    `cd into ${worktree}, the worktree of pull request ${pr}. This is review round ${round} of at most ${ROUND_CAP}. Invoke no skills. Never merge and never run deliver.ts.`,
    'Threads and triage:',
    JSON.stringify(triaged.threads),
    'Fix every thread triaged fix, using your own judgment on each. Answer every thread under AGENTS.md "Review guidelines": fixed (name the commit), declined (one-line reason), or tracked (name the issue). Write the reply file `review-threads.ts resolve` takes and run `bun scripts/chef/review-threads.ts resolve --pr ' +
      pr +
      ' --file <tsv>` after the push.',
    `Before pushing, run \`bun scripts/chef/review-threads.ts classes --pr ${pr}\`; on exit 1 push nothing and return the open thread ids in "open". Also run \`bun scripts/chef/focused-checks.ts\` and fix failures. Batch all fixes into one commit and push once.`,
    'Return round, answered thread ids, fixedHead (the pushed head, or the unchanged head when nothing was fixed), and open thread ids.',
  ].join('\n'),
  {
    label: `answer PR ${pr} round ${round}`,
    phase: 'answer',
    schema: ANSWER_SCHEMA,
    agentType: 'chef-worker',
  },
);
if (answered === null) {
  log(`PR ${pr}: answering failed`);
  return {
    round,
    answered: [],
    fixedHead: null,
    open: triaged.threads.map((t) => t.id),
    error: 'answer failed',
  };
}
log(`PR ${pr}: round ${round} answered ${answered.answered.length}, ${answered.open.length} open`);
return answered;
