export const meta = {
  name: 'deliver-issue',
  description:
    'Chef delivery for COR issues: prepare a brief, implement in a worktree, review, one correction. Never merges.',
  phases: ['prepare', 'implement', 'review', 'correct'],
};

// Concurrency: AGENTS.md "Parallel runs" allows at most two implementation workers at once on this
// host. Issues are processed in chunks of two with parallel(): a chunk finishes completely before
// the next starts, so the bound is exact and easy to read. A pipeline would let a fast stage of
// one issue overlap a slow stage of another and make the bound depend on stage layout.
//
// This workflow never merges. The coordinator moves each returned issue to In Review and runs
// scripts/chef/deliver.ts in its main loop.

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    briefPath: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['briefPath', 'blockers'],
};

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready-for-review', 'blocked', 'needs-decision'] },
    pr: { type: 'string' },
    head: { type: 'string' },
    worktree: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['status', 'pr', 'head', 'worktree', 'report'],
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

const NO_MERGE = 'Never merge the pull request and never run deliver.ts; the coordinator delivers.';

function failure(issue, status, reason, extra) {
  return {
    issue,
    status,
    pr: null,
    head: null,
    worktree: null,
    review: null,
    reason,
    ...extra,
  };
}

function prepare(issue, run) {
  phase('prepare');
  log(`${issue}: preparing the brief`);
  return agent(
    [
      `Prepare chef delivery of ${issue}. Invoke no skills. Make no Linear or GitHub writes.`,
      `Run \`bun scripts/chef/brief.ts ${issue}${run ? ` --run ${run}` : ''} --json\`. A non-zero exit means another run holds the issue: return no briefPath and list that holder as the only blocker. The brief path is \`path\` in its output (tmp/chef/briefs/${issue}.md). Read the brief's open-blockers section and list each open blocker identifier in "blockers" (empty when it says None).`,
      'Return briefPath and blockers.',
    ].join('\n'),
    {
      label: `prepare ${issue}`,
      phase: 'prepare',
      schema: PREPARE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function review(issue, pr, head) {
  phase('review');
  log(`${issue}: reviewing PR ${pr} at ${head}`);
  return agent(
    [
      `Review pull request ${pr} of ${issue} at head ${head}, against the diff of exactly that head (fetch the head if needed; check \`git rev-parse HEAD\` matches).`,
      'Review per your charter and AGENTS.md "Review guidelines". Return verdict approve or blocked, the blocking findings, and the evidence path.',
    ].join('\n'),
    { label: `review ${issue}`, phase: 'review', schema: VERDICT, agentType: 'chef-reviewer' },
  );
}

async function deliverOne(issue) {
  const prepared = await prepare(issue, args && args.run);
  if (prepared === null) {
    log(`${issue}: prepare failed`);
    return failure(issue, 'blocked', 'prepare failed', {});
  }
  if (prepared.blockers.length > 0) {
    log(`${issue}: blocked by open blockers ${prepared.blockers.join(', ')}`);
    return failure(issue, 'blocked', `open blockers: ${prepared.blockers.join(', ')}`, {});
  }

  phase('implement');
  log(`${issue}: dispatching chef-worker from ${prepared.briefPath}`);
  const built = await agent(
    `Implement the issue from the brief file ${prepared.briefPath} and nothing else. This dispatch asks for a pull request: open it non-draft and return its number. ${NO_MERGE}`,
    {
      label: `implement ${issue}`,
      phase: 'implement',
      schema: IMPLEMENT_SCHEMA,
      agentType: 'chef-worker',
      isolation: 'worktree',
      model: 'sonnet',
    },
  );
  if (built === null) {
    log(`${issue}: implementation failed`);
    return failure(issue, 'blocked', 'implementation failed', {});
  }
  if (built.status !== 'ready-for-review') {
    log(`${issue}: worker returned ${built.status}`);
    return failure(issue, built.status, built.report, {
      pr: built.pr,
      head: built.head,
      worktree: built.worktree,
    });
  }

  let head = built.head;
  let verdict = await review(issue, built.pr, head);
  if (verdict === null) {
    log(`${issue}: review failed`);
    return failure(issue, 'needs-decision', 'review failed', {
      pr: built.pr,
      head,
      worktree: built.worktree,
    });
  }
  if (verdict.verdict === 'approve') {
    log(`${issue}: approved at ${head}`);
    return {
      issue,
      status: 'ready-for-review',
      pr: built.pr,
      head,
      worktree: built.worktree,
      review: verdict,
    };
  }

  phase('correct');
  log(`${issue}: blocked by review; one correction`);
  const fixed = await agent(
    [
      `cd into ${built.worktree}, the worktree of pull request ${built.pr}, and fix these blocking review findings, and only these:`,
      ...verdict.findings.map((finding) => `- ${finding}`),
      'Run `bun scripts/chef/focused-checks.ts`, push once, and return the new head. ' + NO_MERGE,
    ].join('\n'),
    {
      label: `correct ${issue}`,
      phase: 'correct',
      schema: CORRECTION_SCHEMA,
      agentType: 'chef-worker',
    },
  );
  if (fixed === null || fixed.status !== 'ready-for-review') {
    log(`${issue}: correction failed; needs a decision`);
    return failure(issue, 'needs-decision', fixed === null ? 'correction failed' : fixed.report, {
      pr: built.pr,
      head,
      worktree: built.worktree,
      review: verdict,
    });
  }
  head = fixed.head;
  verdict = await review(issue, built.pr, head);
  if (verdict === null || verdict.verdict !== 'approve') {
    log(`${issue}: second review still blocked; escalating to the coordinator`);
    return failure(issue, 'needs-decision', 'two failed corrections', {
      pr: built.pr,
      head,
      worktree: built.worktree,
      review: verdict,
    });
  }
  log(`${issue}: approved after one correction at ${head}`);
  return {
    issue,
    status: 'ready-for-review',
    pr: built.pr,
    head,
    worktree: built.worktree,
    review: verdict,
  };
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
      results.push(failure(chunk[offset], 'blocked', 'workflow thread failed', {}));
    } else {
      results.push(done[offset]);
    }
  }
}
log(`done: ${results.length} of ${issues.length} issues returned`);
return results;
