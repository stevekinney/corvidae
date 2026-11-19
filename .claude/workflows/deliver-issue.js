export const meta = {
  name: 'deliver-issue',
  description:
    'Chef branch-path delivery loop: brief, worker, checks, evidence run, wait, compare, review, evidence request. Never merges.',
  phases: ['brief', 'implement', 'check', 'evidence', 'review', 'correct'],
};

// The default delivery path (a branch the coordinator lands with scripts/chef/deliver.ts), as
// code. Every step is one agent call or a script an agent runs; a script's exit code and output
// are the evidence, never a report from the worker. Models come from agent frontmatter alone: a
// typed agent (agentType) never sets `model`; only the untyped shell agents run on Haiku.
//
// Concurrency: AGENTS.md "Parallel runs" allows at most two implementation workers at once on this
// host. Issues run in chunks of two with parallel(): a chunk finishes before the next starts, so
// the bound is exact.
//
// This workflow never merges and never runs deliver.ts. It returns READY_TO_LAND or NEEDS_JUDGMENT
// for each issue, with every step's evidence and the evidence request the coordinator lands from.

const REPOSITORY = 'stevekinney/corvidae';
const MAXIMUM_ROUNDS = 2;

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    briefPath: { type: 'string' },
    error: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
  },
  required: ['exitCode', 'briefPath'],
};

const RECORD_SCHEMA = {
  type: 'object',
  properties: { recorded: { type: 'boolean' }, path: { type: 'string' } },
  required: ['recorded'],
};

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready-for-review', 'blocked', 'needs-decision'] },
    head: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['status', 'head', 'branch', 'worktree', 'report'],
};

const CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    line: { type: 'string' },
    head: { type: 'string' },
  },
  required: ['exitCode', 'line', 'head'],
};

const DISPATCH_SCHEMA = {
  type: 'object',
  properties: {
    dispatched: { type: 'boolean' },
    runId: { type: 'string' },
    url: { type: 'string' },
    ref: { type: 'string' },
    headSha: { type: 'string' },
    inputs: { type: 'object' },
    command: { type: 'array', items: { type: 'string' } },
    requiresFullRun: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['dispatched', 'ref'],
};

const WAIT_SCHEMA = {
  type: 'object',
  properties: {
    run: { type: 'string' },
    headSha: { type: 'string' },
    conclusion: { type: 'string' },
    jobs: { type: 'array', items: { type: 'object' } },
  },
  required: ['conclusion', 'headSha'],
};

const COMPARE_SCHEMA = {
  type: 'object',
  properties: {
    run: { type: 'string' },
    headSha: { type: 'string' },
    conclusion: { type: 'string' },
    complete: { type: 'boolean' },
    noEvidence: { type: 'boolean' },
    hasNew: { type: 'boolean' },
    jobs: { type: 'array', items: { type: 'object' } },
  },
  required: ['headSha', 'complete', 'noEvidence', 'hasNew'],
};

const OVERRIDE_BRIEF_SCHEMA = {
  type: 'object',
  properties: { briefPath: { type: 'string' }, bytes: { type: 'integer' } },
  required: ['briefPath', 'bytes'],
};

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'blocked'] },
    findings: { type: 'array', items: { type: 'string' } },
    evidencePath: { type: 'string' },
  },
  required: ['verdict', 'findings'],
};

const CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready-for-review', 'blocked', 'needs-decision'] },
    head: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['status', 'head', 'report'],
};

const NO_MERGE = 'Never merge and never run deliver.ts; the coordinator lands the branch.';

function judgment(issue, reason, steps, extra) {
  return {
    issue,
    status: 'NEEDS_JUDGMENT',
    reason,
    head: null,
    branch: null,
    worktree: null,
    steps,
    evidenceRequest: null,
    ...extra,
  };
}

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function briefCommand(issue, run, context, classification, stdout) {
  const arguments_ = [
    'bun',
    'scripts/chef/brief.ts',
    shellArgument(issue),
    '--repository',
    REPOSITORY,
    '--base',
    '"$(git rev-parse HEAD)"',
  ];
  if (classification !== null) arguments_.push('--classification', shellArgument(classification));
  if (context !== null) arguments_.push('--context', shellArgument(context));
  if (run !== undefined) arguments_.push('--run', shellArgument(run));
  arguments_.push(stdout ? '--stdout' : '--json');
  return arguments_.join(' ');
}

/** Only after an override: brief.ts writes no file when it refuses, so the brief is generated to stdout. */
function writeOverrideBrief(issue, run, context, classification) {
  return agent(
    [
      `Write the brief of ${issue}. Invoke no skills. Make no Linear or GitHub writes.`,
      'The main checkout is the parent directory of the output of `git rev-parse --path-format=absolute --git-common-dir`. Create its tmp/chef/briefs directory if it is absent.',
      `Run \`${briefCommand(issue, run, context, classification, true)}\` once, with its standard output redirected to <main checkout>/tmp/chef/briefs/${issue}.md as an absolute path. If it prints nothing, leave no file.`,
      'Return briefPath (that absolute path) and bytes (the size of the file in bytes, 0 when there is none).',
    ].join('\n'),
    {
      label: `override brief ${issue}`,
      phase: 'brief',
      schema: OVERRIDE_BRIEF_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function runBrief(issue, run, context, classification) {
  phase('brief');
  log(`${issue}: preparing the brief`);
  return agent(
    [
      `Prepare chef delivery of ${issue}. Invoke no skills. Make no Linear or GitHub writes.`,
      `Run \`${briefCommand(issue, run, context, classification)}\` once and read its exit code and its JSON output. The coordinator supplied ${context ? 'the verified context file' : 'no design context file'} and ${classification ? `the ${classification} classification` : 'no exceptional classification'}; do not invent either from issue text.`,
      'Return exitCode (the exit code of that command), briefPath (the JSON path field, or an empty string) error (the JSON error field or the first line of stderr, when there is one) and paths (the repository paths the brief file lists as owned by the issue, or an empty array).',
    ].join('\n'),
    {
      label: `brief ${issue}`,
      phase: 'brief',
      schema: BRIEF_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function recordOverride(issue, run, override) {
  const line = JSON.stringify({
    event: 'brief-override',
    issue,
    run: run === undefined ? null : run,
    reason: override.reason,
    at: override.at,
  });
  return agent(
    [
      `Append exactly this one line, and nothing else, to the file tmp/chef/events.jsonl of the main checkout, creating the file if it is absent: ${line}`,
      'The main checkout is the parent directory of the output of `git rev-parse --path-format=absolute --git-common-dir`. Use `printf` with a trailing newline. Change no other file. Return recorded true and the file path.',
    ].join('\n'),
    {
      label: `record override ${issue}`,
      phase: 'brief',
      schema: RECORD_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function runChecks(issue, worktree, branch, head) {
  phase('check');
  log(`${issue}: re-running the focused checks at ${head}`);
  return agent(
    [
      `Run the focused checks of ${issue} on the branch head ${head}. Invoke no skills. Change nothing in the repository.`,
      `cd ${worktree}. Run \`git fetch origin ${branch}\`, then confirm \`git rev-parse HEAD\` and \`git rev-parse FETCH_HEAD\` both equal ${head}. If either differs, return exitCode 3, line "head mismatch" and the head you found.`,
      'Otherwise run `bun scripts/chef/focused-checks.ts` once, with its output redirected to a file under tmp/ in that worktree, in the background if it runs long, and wait for it to exit. Never rerun it. Return exitCode (its exit code), line (the last non-empty line of that file) and head.',
    ].join('\n'),
    {
      label: `checks ${issue}`,
      phase: 'check',
      schema: CHECKS_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function dispatchEvidence(issue, worktree, branch, head) {
  phase('evidence');
  log(`${issue}: dispatching the evidence run for ${head}`);
  return agent(
    [
      `Dispatch the evidence run of ${issue}. Invoke no skills. Change nothing in the repository.`,
      `cd ${worktree}. Run \`git fetch origin main ${branch}\` and confirm \`git rev-parse HEAD\` equals ${head}; if it differs, return dispatched false and an error.`,
      'First run `bun scripts/chef/targeted-run.ts --dry-run --json` and read ref, inputs, command and requiresFullRun (treat an absent requiresFullRun as false). If requiresFullRun is true, dispatch nothing: return dispatched false with those fields.',
      'Otherwise run `bun scripts/chef/targeted-run.ts --json` once, which dispatches the workflow. Then find that run by its head SHA, never as the latest run: list `gh run list --workflow targeted-checks.yml --branch <ref> --event workflow_dispatch --json databaseId,headSha,url` and take the newest entry whose headSha equals the head above (if there is none, return dispatched false and an error). Read that run again with `gh run view <id> --json headSha`. Return dispatched true, runId (the databaseId as a string), headSha (from that last command), url, ref, inputs, command and requiresFullRun.',
    ].join('\n'),
    {
      label: `dispatch ${issue}`,
      phase: 'evidence',
      schema: DISPATCH_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function waitForRun(issue, runId) {
  log(`${issue}: waiting for run ${runId}`);
  return agent(
    [
      `Wait for GitHub Actions run ${runId}. Invoke no skills. Change nothing in the repository.`,
      `Run \`bun scripts/chef/wait-run.ts ${runId} --json\` once, in the background, and wait for it to exit; never use \`gh run watch\` and never poll in a loop of your own. Then run \`gh run view ${runId} --json headSha\`. Return its JSON (run, conclusion and jobs) with headSha from the second command.`,
    ].join('\n'),
    {
      label: `wait ${issue}`,
      phase: 'evidence',
      schema: WAIT_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function compareRun(issue, runId) {
  log(`${issue}: judging run ${runId} against main`);
  return agent(
    [
      `Judge GitHub Actions run ${runId}. Invoke no skills. Change nothing in the repository.`,
      `Run \`bun scripts/chef/ci-compare.ts ${runId} --json\` once, then run \`gh run view ${runId} --json headSha\`. Return its JSON (run, conclusion, complete, noEvidence, hasNew and jobs) with headSha from the second command.`,
    ].join('\n'),
    {
      label: `compare ${issue}`,
      phase: 'evidence',
      schema: COMPARE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function review(issue, branch, head) {
  phase('review');
  log(`${issue}: reviewing ${branch} at ${head}`);
  return agent(
    [
      `Review branch ${branch} of ${issue} at head ${head}, against the diff of exactly that head (fetch the branch if needed; check \`git rev-parse HEAD\` matches).`,
      'Review per your charter and AGENTS.md "Review guidelines". Return verdict approve or blocked, the blocking findings, and the evidence path.',
    ].join('\n'),
    { label: `review ${issue}`, phase: 'review', schema: VERDICT, agentType: 'chef-reviewer' },
  );
}

// The model of the implementing worker and its correction is chosen here, by rule, per issue:
// Opus for design-heavy interface work, Sonnet otherwise. Every other agent takes its model from
// its frontmatter (the reviewer) or is the untyped Haiku shell agent.
const INTERFACE_PATH =
  /^(applications\/interborough\/src\/(app|routes|views|styles)\/|components\/[^/]+\/src\/)/;

function chooseModel(issue, paths) {
  if (args && args.models && Object.hasOwn(args.models, issue) && args.models[issue] === 'opus')
    return { model: 'opus', rule: 'args.models names opus for the issue' };
  const reached = paths.find((path) => INTERFACE_PATH.test(path));
  if (reached !== undefined)
    return { model: 'opus', rule: `owned path ${reached} is design-heavy interface work` };
  return { model: 'sonnet', rule: 'no design-heavy interface path or explicit opus entry' };
}

function correct(issue, worktree, branch, findings, model) {
  phase('correct');
  log(`${issue}: one correction of ${findings.length} finding(s)`);
  return agent(
    [
      `cd into ${worktree}, the worktree of branch ${branch}, and fix these findings, and only these:`,
      ...findings.map((finding) => `- ${finding}`),
      `Run \`bun scripts/chef/focused-checks.ts\`, push the branch ${branch} once, and return the new head. ${NO_MERGE}`,
    ].join('\n'),
    {
      label: `correct ${issue}`,
      phase: 'correct',
      schema: CORRECTION_SCHEMA,
      agentType: 'chef-worker',
      model: model,
    },
  );
}

/** The structured result the coordinator lands from: only facts a step returned. */
function evidenceRequest(issue, run, built, head, evidence, verdict, override, chosen) {
  return {
    workerModel: { model: chosen.model, rule: chosen.rule },
    issue,
    run: run === undefined ? null : run,
    repository: REPOSITORY,
    revision: head,
    branch: built.branch,
    ref: evidence.dispatch.ref,
    ciRun: evidence.dispatch.runId,
    ciUrl: evidence.dispatch.url === undefined ? null : evidence.dispatch.url,
    inputs: evidence.dispatch.inputs === undefined ? null : evidence.dispatch.inputs,
    command: evidence.dispatch.command === undefined ? null : evidence.dispatch.command,
    checks: evidence.checks.line,
    comparison: {
      complete: evidence.compare.complete,
      noEvidence: evidence.compare.noEvidence,
      hasNew: evidence.compare.hasNew,
    },
    review: { verdict: verdict.verdict, evidencePath: verdict.evidencePath },
    override: override === null ? null : override,
  };
}

function verifyBlockers(evidence) {
  const blockers = [];
  if (evidence.checks.exitCode !== 0)
    blockers.push(`focused checks failed: ${evidence.checks.line}`);
  return blockers;
}

async function deliverOne(issue) {
  const run = args && args.run;
  const context =
    args && args.verifiedContexts && typeof args.verifiedContexts[issue] === 'string'
      ? args.verifiedContexts[issue]
      : null;
  const classification =
    args && args.classifications && typeof args.classifications[issue] === 'string'
      ? args.classifications[issue]
      : null;
  if (classification !== null && classification !== 'behavior' && classification !== 'no-behavior')
    return judgment(issue, 'invalid coordinator classification', {});
  // args.override maps an issue identifier to { reason, at }; an issue without its own entry is not
  // overridden.
  const override =
    args &&
    args.override &&
    typeof args.override === 'object' &&
    Object.hasOwn(args.override, issue) &&
    args.override[issue]
      ? args.override[issue]
      : null;
  if (
    override !== null &&
    (typeof override.reason !== 'string' ||
      override.reason.trim() === '' ||
      typeof override.at !== 'string' ||
      override.at.trim() === '')
  )
    return judgment(issue, 'invalid override: it needs a reason and a time', {});

  const steps = {};
  const prepared = await runBrief(issue, run, context, classification);
  if (prepared === null) return judgment(issue, 'brief step failed', steps);
  steps.brief = prepared;
  let briefPath = prepared.briefPath.trim();
  let overridden = null;
  if (prepared.exitCode !== 0) {
    if (override === null) {
      log(`${issue}: brief refused (exit ${prepared.exitCode}); no worker`);
      return judgment(
        issue,
        `brief refused: ${prepared.error || `exit ${prepared.exitCode}`}`,
        steps,
      );
    }
    const recorded = await recordOverride(issue, run, override);
    if (recorded === null || recorded.recorded !== true)
      return judgment(issue, 'brief override could not be recorded', steps);
    steps.override = recorded;
    overridden = { reason: override.reason, at: override.at };
    const written = await writeOverrideBrief(issue, run, context, classification);
    if (written === null) return judgment(issue, 'override brief step failed', steps);
    steps.overrideBrief = written;
    briefPath = written.briefPath.trim();
    if (
      written.bytes <= 0 ||
      !briefPath.startsWith('/') ||
      !briefPath.endsWith(`/tmp/chef/briefs/${issue}.md`)
    )
      return judgment(issue, 'override produced no brief; no worker', steps);
    log(`${issue}: brief override recorded: ${override.reason}`);
  } else if (briefPath === '') {
    return judgment(issue, 'brief exited 0 without a brief path', steps);
  }

  const ownedPaths = [
    ...(args && args.paths && Array.isArray(args.paths[issue]) ? args.paths[issue] : []),
    ...(Array.isArray(prepared.paths) ? prepared.paths : []),
  ].filter((path) => typeof path === 'string');
  const chosen = chooseModel(issue, ownedPaths);
  steps.model = chosen;
  phase('implement');
  log(`${issue}: dispatching chef-worker (${chosen.model}: ${chosen.rule}) from ${briefPath}`);
  const built = await agent(
    `Implement the issue from the brief file ${briefPath} and nothing else. This is the branch path: push your branch, open no pull request, and return the pushed head, the branch name and your worktree path. ${NO_MERGE}`,
    {
      label: `implement ${issue}`,
      phase: 'implement',
      schema: IMPLEMENT_SCHEMA,
      agentType: 'chef-worker',
      isolation: 'worktree',
      model: chosen.model,
    },
  );
  if (built === null) return judgment(issue, 'implementation failed', steps);
  steps.implement = built;
  if (built.status !== 'ready-for-review')
    return judgment(issue, `worker returned ${built.status}: ${built.report}`, steps, {
      head: built.head,
      branch: built.branch,
      worktree: built.worktree,
    });

  let head = built.head;
  for (let round = 1; round <= MAXIMUM_ROUNDS; round += 1) {
    const where = { head, branch: built.branch, worktree: built.worktree };
    const evidence = {};
    steps[`round${round}`] = evidence;

    const checks = await runChecks(issue, built.worktree, built.branch, head);
    if (checks === null) return judgment(issue, 'checks step failed', steps, where);
    evidence.checks = checks;
    if (checks.head !== head)
      return judgment(
        issue,
        `focused checks ran at ${checks.head}, not the pushed head ${head}`,
        steps,
        where,
      );
    let findings = verifyBlockers(evidence);

    if (findings.length === 0) {
      const dispatch = await dispatchEvidence(issue, built.worktree, built.branch, head);
      if (dispatch === null) return judgment(issue, 'evidence dispatch failed', steps, where);
      evidence.dispatch = dispatch;
      if (dispatch.requiresFullRun === true)
        return judgment(issue, 'the change needs a full main.yml run', steps, where);
      if (dispatch.dispatched !== true || !dispatch.runId)
        return judgment(
          issue,
          `evidence run not dispatched: ${dispatch.error || 'no run id'}`,
          steps,
          where,
        );
      // Each step reports the commit its run belongs to; evidence for another commit is no evidence.
      const stale = (step, sha) =>
        judgment(issue, `${step} is for commit ${sha}, not the pushed head ${head}`, steps, where);
      if (dispatch.headSha !== head) return stale('evidence dispatch', dispatch.headSha);
      const waited = await waitForRun(issue, dispatch.runId);
      if (waited === null) return judgment(issue, 'wait step failed', steps, where);
      evidence.wait = waited;
      if (waited.headSha !== head) return stale('wait', waited.headSha);
      const compared = await compareRun(issue, dispatch.runId);
      if (compared === null) return judgment(issue, 'compare step failed', steps, where);
      evidence.compare = compared;
      if (compared.headSha !== head) return stale('compare', compared.headSha);
      if (compared.complete !== true) findings.push(`run ${dispatch.runId} did not complete`);
      if (compared.noEvidence === true) findings.push(`run ${dispatch.runId} produced no evidence`);
      if (compared.hasNew === true)
        findings.push(`run ${dispatch.runId} has failures that are new against main`);

      if (findings.length === 0) {
        const verdict = await review(issue, built.branch, head);
        if (verdict === null) return judgment(issue, 'review failed', steps, where);
        evidence.review = verdict;
        if (verdict.verdict === 'approve') {
          log(`${issue}: ready to land at ${head}`);
          return {
            issue,
            status: 'READY_TO_LAND',
            reason: `approved at ${head} after ${round} round(s)`,
            ...where,
            steps,
            evidenceRequest: evidenceRequest(
              issue,
              run,
              built,
              head,
              evidence,
              verdict,
              overridden,
              chosen,
            ),
          };
        }
        findings = verdict.findings;
      }
    }

    if (round === MAXIMUM_ROUNDS)
      return judgment(issue, `still failing after ${MAXIMUM_ROUNDS} rounds`, steps, {
        ...where,
        findings,
      });
    const fixed = await correct(issue, built.worktree, built.branch, findings, chosen.model);
    if (fixed === null || fixed.status !== 'ready-for-review')
      return judgment(
        issue,
        fixed === null ? 'correction failed' : `correction ${fixed.status}: ${fixed.report}`,
        steps,
        { ...where, findings },
      );
    head = fixed.head;
  }
  return judgment(issue, 'no round ran', steps, {});
}

const issues = Array.isArray(args && args.issues) ? args.issues : [];
if (issues.length === 0) {
  log('no issues given; args.issues must be a non-empty array of COR ids');
}

const results = [];
for (let index = 0; index < issues.length; index += 2) {
  const chunk = issues.slice(index, index + 2);
  log(`chunk ${index / 2 + 1}: ${chunk.join(', ')}`);
  const done = await parallel(chunk.map((issue) => () => deliverOne(issue)));
  for (let offset = 0; offset < chunk.length; offset += 1) {
    if (done[offset] === null || done[offset] === undefined) {
      log(`${chunk[offset]}: dropped, its delivery thread failed`);
      results.push(judgment(chunk[offset], 'workflow thread failed', {}));
    } else {
      results.push(done[offset]);
    }
  }
}
log(`done: ${results.length} of ${issues.length} issues returned`);
return results;
