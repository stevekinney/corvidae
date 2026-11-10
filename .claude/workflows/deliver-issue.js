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

const SHADOW_EVIDENCE_NOTE =
  'Shadow predicates are measurement only: record the call, never change what you do because of it. ' +
  'Write the evidence JSON under tmp/chef/, then run ' +
  '`bun scripts/chef/jev-predicates.ts shadow <predicate> --evidence-file <file> --json` and keep the id it returns. ' +
  'If the call fails or Jev is unavailable, continue and report no id.';

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    briefPath: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    shadow: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          predicate: { type: 'string' },
          id: { type: 'string' },
          decision: { type: 'string' },
        },
        required: ['predicate'],
      },
    },
  },
  required: ['briefPath', 'blockers', 'shadow'],
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

const ESCALATE_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, decision: { type: 'string' } },
  required: [],
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
    shadowIds: [],
    reason,
    ...extra,
  };
}

function prepare(issue) {
  phase('prepare');
  log(`${issue}: preparing brief and shadow predicates`);
  return agent(
    [
      `Prepare chef delivery of ${issue}. Invoke no skills. Make no Linear or GitHub writes.`,
      `1. Run \`bun scripts/chef/brief.ts ${issue} --json\`. The brief path is \`path\` in its output (tmp/chef/briefs/${issue}.md). Read the brief's open-blockers section and list each open blocker identifier in "blockers" (empty when it says None).`,
      '2. From the brief, write evidence JSON to tmp/chef/ for the shadow predicates `dispatch-plan` and `split-before-dispatch`: {"criteria": [...], "files": [...], "estimatedLines": <number>, "oneWayDoor": <true|false>}.',
      `3. ${SHADOW_EVIDENCE_NOTE} Run it for both predicates.`,
      'Return briefPath, blockers, and shadow as [{predicate, id, decision}].',
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
      'First run the shadow predicate `review-tier`: write evidence {"files": <n>, "additions": <n>, "deletions": <n>, "oneWayDoor": <bool>, "paths": [...]} under tmp/chef/. ' +
        SHADOW_EVIDENCE_NOTE,
      'Then review per your charter and AGENTS.md "Review guidelines". Return verdict approve or blocked, the blocking findings, and the evidence path.',
    ].join('\n'),
    { label: `review ${issue}`, phase: 'review', schema: VERDICT, agentType: 'chef-reviewer' },
  );
}

async function deliverOne(issue) {
  const shadowIds = [];
  const prepared = await prepare(issue);
  if (prepared === null) {
    log(`${issue}: prepare failed`);
    return failure(issue, 'blocked', 'prepare failed', {});
  }
  for (const entry of prepared.shadow) if (entry.id) shadowIds.push(entry.id);
  if (prepared.blockers.length > 0) {
    log(`${issue}: blocked by open blockers ${prepared.blockers.join(', ')}`);
    return failure(issue, 'blocked', `open blockers: ${prepared.blockers.join(', ')}`, {
      shadowIds,
    });
  }

  phase('implement');
  log(`${issue}: dispatching chef-worker from ${prepared.briefPath}`);
  const built = await agent(
    `Implement the issue from the brief file ${prepared.briefPath} and nothing else. ${NO_MERGE}`,
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
    return failure(issue, 'blocked', 'implementation failed', { shadowIds });
  }
  if (built.status !== 'ready-for-review') {
    log(`${issue}: worker returned ${built.status}`);
    return failure(issue, built.status, built.report, {
      pr: built.pr,
      head: built.head,
      worktree: built.worktree,
      shadowIds,
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
      shadowIds,
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
      shadowIds,
    };
  }

  phase('correct');
  log(`${issue}: blocked by review; one correction (shadow escalate first)`);
  const escalation = await agent(
    [
      `Run the shadow predicate \`escalate\` for ${issue}. Write evidence {"corrections": 0, "lastFailure": ${JSON.stringify(verdict.findings.join(' | ').slice(0, 800))}} under tmp/chef/. ${SHADOW_EVIDENCE_NOTE}`,
      'Return the id and decision.',
    ].join('\n'),
    {
      label: `escalate ${issue}`,
      phase: 'correct',
      schema: ESCALATE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
  if (escalation !== null && escalation.id) shadowIds.push(escalation.id);

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
      shadowIds,
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
      shadowIds,
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
    shadowIds,
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
