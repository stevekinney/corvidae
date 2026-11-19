export const meta = {
  name: 'answer-threads',
  description:
    'One review round for a chef pull request: triage unresolved threads, fix and answer them, push once. Never merges.',
  phases: ['triage', 'answer'],
};

// args: { pr, worktree, round, brief? }. AGENTS.md "Review guidelines" caps review at three rounds
// and asks for one push per round. This workflow never merges; the coordinator delivers. `brief`
// is the issue's brief file (`tmp/chef/briefs/<ID>.md`): the fixer starts fresh, so without the
// acceptance criteria and any outcome matrix it cannot judge a fix and tends to push nothing.

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
    reason: { type: 'string' },
    regressionTest: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        failsOn: { type: 'string' },
        passesOn: { type: 'string' },
      },
      required: ['path', 'failsOn', 'passesOn'],
    },
    entryPoints: { type: 'array', items: { type: 'string' } },
    replyFile: { type: 'string' },
  },
  required: ['round', 'answered', 'fixedHead', 'open'],
};

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    head: { type: 'string' },
    repeating: { type: 'array', items: { type: 'string' } },
  },
  required: ['head', 'repeating'],
};

const PIN_SCHEMA = {
  type: 'object',
  properties: {
    priorExitCode: { type: 'integer' },
    priorHead: { type: 'string' },
    newExitCode: { type: 'integer' },
    newHead: { type: 'string' },
    priorOutput: { type: 'string' },
  },
  required: ['priorExitCode', 'priorHead', 'newExitCode', 'newHead', 'priorOutput'],
};

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    resolved: { type: 'array', items: { type: 'string' } },
  },
  required: ['exitCode'],
};

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// scripts/bun-test.ts exits 75 when the test pool is busy and 70 when the hang guard fires: neither
// says anything about the test, so only exit 1 with a (fail) line under the pinned file counts.
// Kept equal to the same function in deliver-issue.js.
const NOT_A_RESULT = [70, 75];

/** null when the pin ran and proved the test; else the reason it did not. */
function pinProblem(pin, test) {
  if (pin.priorHead !== test.failsOn || pin.newHead !== test.passesOn)
    return 'regression test was proven at the wrong commits';
  if (NOT_A_RESULT.includes(pin.priorExitCode) || NOT_A_RESULT.includes(pin.newExitCode))
    return `pin did not run: regression test exited ${pin.priorExitCode} then ${pin.newExitCode} (busy pool or hang guard)`;
  if (pin.priorExitCode === 0)
    return `regression test passes on the pre-fix head ${test.failsOn}, so it pins nothing`;
  const output = typeof pin.priorOutput === 'string' ? pin.priorOutput : '';
  const at = output.indexOf(test.path);
  if (pin.priorExitCode !== 1 || at < 0 || !/^\(fail\) /m.test(output.slice(at)))
    return `pin did not run: regression test at ${test.failsOn} gave exit ${pin.priorExitCode} and no (fail) line under ${test.path}`;
  if (pin.newExitCode !== 0)
    return `regression test fails on the new head ${test.passesOn} (exit ${pin.newExitCode})`;
  return null;
}

const pr = args && args.pr;
const worktree = args && args.worktree;
const brief = args && args.brief;
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

// The same correction rules as deliver-issue.js: a repeated defect class gets a CLASS_FIX, and every
// fix returns a regression test proven to fail on the pre-fix head and pass on the new one.
phase('answer');
const classified = await agent(
  [
    `cd ${worktree}. Invoke no skills. Change nothing in the repository.`,
    `Run \`bun scripts/chef/review-threads.ts classes --pr ${pr} --json\` (exit 1 is a normal result) and \`git rev-parse HEAD\`. Return head (that SHA) and repeating (the "repeating" array of the JSON).`,
  ].join('\n'),
  {
    label: `classify PR ${pr}`,
    phase: 'answer',
    schema: CLASSIFY_SCHEMA,
    model: 'haiku',
    effort: 'low',
  },
);
if (classified === null) {
  log(`PR ${pr}: classification failed`);
  return {
    round,
    answered: [],
    fixedHead: null,
    open: triaged.threads.map((t) => t.id),
    error: 'classify failed',
  };
}
const classFix = classified.repeating.length > 0;
if (classFix) log(`PR ${pr}: CLASS_FIX for ${classified.repeating.join(', ')}`);
const answered = await agent(
  [
    `cd into ${worktree}, the worktree of pull request ${pr}. This is review round ${round} of at most ${ROUND_CAP}. Invoke no skills. Never merge and never run deliver.ts.`,
    brief
      ? `Read the issue's brief at ${brief} first: its acceptance criteria and any outcome matrix are what a fix must keep true.`
      : 'No brief was given: read the pull request body for the acceptance criteria before fixing.',
    'Threads and triage:',
    JSON.stringify(triaged.threads),
    'Fix every thread triaged fix, using your own judgment on each. Answer every thread under AGENTS.md "Review guidelines": fixed (name the commit), declined (one-line reason), or tracked (name the issue). Write the reply file `review-threads.ts resolve` takes (a tsv under tmp/) and return its path as replyFile; never run `resolve` yourself: the script resolves the threads only after it has proven your regression test.',
    classFix
      ? `CLASS_FIX: the class ${classified.repeating.join(', ')} already repeated across rounds, so a point fix is refused. For the threads of that class the criterion is a test that enumerates every entry point of the class (every route, exported boundary or hook it can reach), not the one instance; return entryPoints, the entry points it covers.`
      : 'Fix each instance the threads name.',
    `Whenever you push a fix, write the regression test first, run it on the pre-fix head ${classified.head} (it must fail there), and return regressionTest: path (the test file), failsOn (${classified.head}) and passesOn (the pushed head). Never edit a test to make it pass. Run only the test files you changed and the tests beside each changed source file, through the pooled wrapper with a bounded wait (\`CORVIDAE_TEST_POOL_WAIT_SECONDS=300 bun scripts/bun-test.ts <files>\`), plus \`bun run lint:root\`, because CI on the branch is the full evidence (owner decision, 2026-11-16). Never wait for a CI run. Fix every failure. Each fix gets a regression test that fails without it. Batch all fixes into one commit and push once.`,
    'Return round, answered thread ids, fixedHead (the pushed head, or the unchanged head when nothing was fixed), open thread ids, and, whenever a thread triaged fix is still open, "reason": one sentence on what stopped you.',
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
// A refusal leaves every thread open and reports no fixed head, in the shape deliver-issue.js gives.
const refuse = (reason) => {
  log(`PR ${pr}: NEEDS_JUDGMENT: ${reason}`);
  return {
    round,
    status: 'NEEDS_JUDGMENT',
    reason,
    error: reason,
    answered: [],
    fixedHead: null,
    pushedHead: answered.fixedHead || null,
    open: triaged.threads.map((t) => t.id),
  };
};
// Nothing is resolved until the correction is proven: the answer step only writes the reply file.
if (answered.fixedHead && answered.fixedHead !== classified.head) {
  const test = answered.regressionTest;
  if (
    !test ||
    typeof test.path !== 'string' ||
    !TEST_FILE.test(test.path) ||
    test.failsOn !== classified.head ||
    test.passesOn !== answered.fixedHead
  )
    return refuse('correction refused: no failing-first regression test');
  if (classFix && !(Array.isArray(answered.entryPoints) && answered.entryPoints.length > 0))
    return refuse('class fix refused: its test must enumerate every entry point of the class');
  const pin = await agent(
    [
      `Prove the regression test ${test.path} of pull request ${pr} fails before the fix and passes after it. Invoke no skills. Change nothing in the repository.`,
      `cd ${worktree}. Do this once for ${test.failsOn} and once for ${test.passesOn}: \`git worktree add --detach <a new path under tmp/> <sha>\`; in it run \`bun install --frozen-lockfile\`; for the pre-fix sha copy the test file from the new sha with \`git show ${test.passesOn}:${test.path}\`; run \`CORVIDAE_TEST_POOL_WAIT_SECONDS=300 bun scripts/bun-test.ts ${test.path}\` there, and record its exit code and \`git rev-parse HEAD\` there; then \`git worktree remove --force\` that path.`,
      `Return priorExitCode and priorHead (the run at ${test.failsOn}), priorOutput (that run's output, verbatim: the file header line and every (fail) line) and newExitCode and newHead (the run at ${test.passesOn}). Report a setup failure as its real exit code; never turn it into 1.`,
    ].join('\n'),
    {
      label: `pin PR ${pr}`,
      phase: 'answer',
      schema: PIN_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
  if (pin === null) return refuse('pin did not run: the pin step failed');
  const problem = pinProblem(pin, test);
  if (problem !== null) return refuse(problem);
}
if (answered.answered.length > 0) {
  if (!answered.replyFile) return refuse('answer returned answered threads but no reply file');
  const resolved = await agent(
    `cd ${worktree}. Invoke no skills. Run \`bun scripts/chef/review-threads.ts resolve --pr ${pr} --file ${answered.replyFile} --json\` once and return its exit code and the thread ids it resolved.`,
    {
      label: `resolve PR ${pr}`,
      phase: 'answer',
      schema: RESOLVE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
  if (resolved === null || resolved.exitCode !== 0)
    return { ...answered, error: 'resolve failed: threads are still open' };
}
log(`PR ${pr}: round ${round} answered ${answered.answered.length}, ${answered.open.length} open`);
return answered;
