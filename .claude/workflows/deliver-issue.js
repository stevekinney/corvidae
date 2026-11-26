export const meta = {
  name: 'deliver-issue',
  description:
    'Chef branch-path delivery loop: brief, worker, checks, review, evidence run, wait, compare, evidence request. Never merges.',
  phases: ['brief', 'critique', 'implement', 'check', 'review', 'evidence', 'correct'],
};

// The coordinator runs brief.ts with --json and the pinned repository and base. In
// args.preparedBriefs[issue], record its process exit as exitCode, its JSON path as
// briefPath (empty on refusal), and copy the matching assignment's identity.base into base.
// Preserve error, needsResolvedRows and owned paths.
// Set validated only after checking the result and issue identity. After a design
// critique, the coordinator can rerun preparation against the validated rows and
// resume with the resulting brief. An owner-approved override similarly takes a
// coordinator-written result in args.overrideBriefs, with the verified file byte count.
//
// Concurrency: AGENTS.md "Parallel runs" allows at most two implementation workers at once on this
// host. Issues run in chunks of two with parallel(): a chunk finishes before the next starts, so
// the bound is exact.
//
// This workflow never merges and never runs deliver.ts. It returns READY_TO_LAND or NEEDS_JUDGMENT
// for each issue, with every step's evidence and the evidence request the coordinator lands from.

const REPOSITORY = 'stevekinney/corvidae';
const MAXIMUM_ROUNDS = 2;

function normalizeCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

// What the pre-build design critique returns; scripts/chef/design-rows-resolved.ts defines the
// file and design-critique.ts validates it before writing, so the schema only shapes the answer.
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          board: { type: 'string' },
          text: { type: 'string' },
          states: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                route: { type: 'string' },
                state: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['ready', 'loading', 'empty', 'first-run', 'error', 'forbidden', 'other'],
                },
                witness: {
                  type: 'object',
                  properties: {
                    specification: { type: 'string' },
                    title: { type: 'string' },
                    world: { type: 'string' },
                    profiles: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          width: { type: 'integer' },
                          theme: { type: 'string', enum: ['light', 'dark'] },
                          targets: { type: 'array', items: { type: 'string' } },
                          visible: { type: 'string' },
                          scrolling: { type: 'string', enum: ['none', 'outlet'] },
                        },
                        required: ['name', 'width', 'theme', 'targets', 'visible', 'scrolling'],
                      },
                    },
                  },
                  required: ['specification', 'title', 'world', 'profiles'],
                },
              },
              required: ['route', 'state', 'kind', 'witness'],
            },
          },
          widths: { type: 'array', items: { type: 'integer' } },
          themes: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] } },
        },
        required: ['id', 'board', 'text', 'states'],
      },
    },
    checked: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          literal: { type: 'string' },
          result: { type: 'string', enum: ['consistent', 'conflict'] },
        },
        required: ['literal', 'result'],
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          rows: { type: 'array', items: { type: 'string' } },
          resolution: { type: 'string', enum: ['decision', 'deferral'] },
          reason: { type: 'string' },
        },
        required: ['criterion', 'rows', 'resolution', 'reason'],
      },
    },
  },
  required: ['rows', 'checked', 'conflicts'],
};

const RESOLVE_SCHEMA = {
  type: 'object',
  properties: { exitCode: { type: 'integer' }, error: { type: 'string' } },
  required: ['exitCode'],
};

const RECORD_SCHEMA = {
  type: 'object',
  properties: { recorded: { type: 'boolean' }, path: { type: 'string' } },
  required: ['recorded'],
};

const FETCH_BASE_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    base: { type: 'string' },
    error: { type: 'string' },
    ancestor: { type: 'boolean' },
    briefDigest: { type: 'string' },
    currentDigest: { type: 'string' },
  },
  required: ['exitCode'],
};

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready-for-review', 'blocked', 'needs-decision'] },
    head: { type: 'string' },
    startingBase: { type: 'string' },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['status', 'startingBase', 'head', 'branch', 'worktree', 'report'],
};

const CHECKS_SCHEMA = {
  type: 'object',
  properties: {
    exitCode: { type: 'integer' },
    line: { type: 'string' },
    head: { type: 'string' },
    reportOk: { type: 'boolean' },
    reportProblems: { type: 'array', items: { type: 'string' } },
    pending: { type: 'array', items: { type: 'string' } },
  },
  required: ['exitCode', 'line', 'head', 'reportOk'],
};

const PENDING_SCHEMA = {
  type: 'object',
  properties: {
    head: { type: 'string' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, exitCode: { type: 'integer' } },
        required: ['command', 'exitCode'],
      },
    },
  },
  required: ['head', 'results'],
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
    decisionFile: { type: 'string' },
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

// The contract check's answer (`.claude/agents/stickler.md`): "Conforms to the contract" or
// "N departures". A departure is a not-met criterion, a departure from a decision, constraint or
// out-of-scope item, or an unexplained hunk; an unverifiable criterion is reported, not blocking.
const VERDICT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['conforms', 'departures'] },
    departures: { type: 'array', items: { type: 'string' } },
    unverifiable: { type: 'array', items: { type: 'string' } },
    evidencePath: { type: 'string' },
  },
  required: ['status', 'departures'],
};

const CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready-for-review', 'blocked', 'needs-decision'] },
    head: { type: 'string' },
    report: { type: 'string' },
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
  },
  required: ['status', 'head', 'report'],
};

// The defect classes of scripts/chef/defect-classes.json (a test keeps the two lists equal).
const CLASS_NAMES = [
  'adapter-drop',
  'pre-commit-exposure',
  'unfenced-check-then-act',
  'stale-generation',
  'receipt-mismatch',
  'missing-authorization',
  'boundary-validation',
  'unsnapshotted-input',
  'spec-contradiction',
  'state-machine',
];

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    classes: { type: 'array', items: { type: 'string', enum: CLASS_NAMES } },
    seenOnBranch: { type: 'array', items: { type: 'string', enum: CLASS_NAMES } },
  },
  required: ['classes', 'seenOnBranch'],
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

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// scripts/bun-test.ts exits 75 when the test pool is busy and 70 when the hang guard fires: neither
// says anything about the test, so only exit 1 with a (fail) line under the pinned file counts.
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

/**
 * The pre-build critique of an issue's design rows, run only for an issue whose brief was refused
 * for want of rows.resolved.json (brief.ts refuses an issue with design rows until the file is
 * valid). An Opus design-reviewer declares each row's states and settles each conflict between a
 * row and a literal criterion of the issue (COR-2444's 700px) as a decision or a deferral; a script
 * validates and writes the file, because the reviewer is read-only and a model's file is not
 * trusted. Returns a judgment when the critique or the file failed, otherwise null.
 */
async function resolveRows(issue, steps, context) {
  phase('critique');
  log(`${issue}: design rows need rows.resolved.json; running the pre-build critique`);
  const critiqued = await agent(
    [
      `Critique the design rows of ${issue} before anything is built, in critique mode of the design-review skill's findings reference. You are read-only; write no file.`,
      `Run \`bun scripts/chef/design-critique.ts rows ${issue}\` and read its JSON: rowIds, literals (every literal pixel criterion in the issue) and the description. Read the boards under tmp/chef/briefs/${issue}/boards/ of the main checkout when they exist (the main checkout is the parent directory of the output of \`git rev-parse --path-format=absolute --git-common-dir\`).${
        context
          ? ` The coordinator's verified copy of the design is in ${context}, a JSON array of locator and content entries; read it with Read, since it is the only copy of the canvas you can see.`
          : ' The coordinator supplied no design context file, so the issue text and any saved boards are all there is; say so in a deferral rather than guess a row.'
      }`,
      'This dispatch is a pre-build critique of rows, not a screenshot review: use Bash only for that command and for greps, and return the JSON the schema names instead of the findings formats.',
      'For every row id: declare each state the row covers as a route (a route pattern from applications/interborough/src/app/routes.ts) and the exact state name a capture specification writes (grep the `state:` strings in applications/interborough/tests/e2e), with a kind. First-run and empty states are first-class: declare them whenever the row shows them. Leave widths and themes out unless the row narrows them; the default is 1920, 1280 and 375 in light and dark because the state specs capture only those. Name 768 in widths only for a ready state with data, which the showcase specs capture.',
      'For every state, also name its physical viewport witness (COR-2574): the repository-relative Playwright specification that captures it (`applications/interborough/tests/e2e/<name>.spec.ts` or `applications/interborough/tests/panels/<name>.spec.ts`), the full project-qualified title of the one test that captures it, exactly as `cd applications/interborough && bun --bun playwright test --list <specification>` prints it with the ` › ` separators and the brackets around the project removed and words joined by single spaces (for example `chromium e2e/runs-states.spec.ts /runs ready at 375 pixels`), the fixture world the capture records, which is the host the spec opens the page on (`sample-world` for the showcase host the state specs use, `first-run`, `plugin-pages`, `stress` for `responsive.spec.ts`, otherwise `e2e-host`; `designReviewWorld` in `applications/interborough/tests/e2e/design-review-capture.ts` decides it), and at least one profile: a kebab-case name, a width the spec captures (a phone width for the narrow witness), a theme, the targets that must be wholly inside that viewport (stable `data-testid` values, or `role:<role>:<exact accessible name>`), what a reviewer should see in the frame including any intended scrolling, and `scrolling` (`outlet` when the test scrolls the targets into view, otherwise `none`). Name only specifications and titles the listing shows.',
      'For every literal criterion in `literals`: say whether the rows are consistent with it or conflict with it (`checked`). Record each conflict, and each pair of rows that contradict each other, as a decision or a deferral with a reason, in `conflicts`. Never leave one open; when you cannot choose, defer it with the reason "owner decision needed".',
      'Return rows (id, board, text, states with their witnesses, optional widths and themes), checked and conflicts.',
    ].join('\n'),
    {
      label: `critique ${issue}`,
      phase: 'critique',
      schema: CRITIQUE_SCHEMA,
      agentType: 'design-reviewer',
    },
  );
  if (critiqued === null) return judgment(issue, 'design critique failed', steps);
  steps.critique = critiqued;
  const written = await agent(
    [
      `Record the design critique of ${issue}. Invoke no skills. Change nothing else in the repository.`,
      `Write exactly this JSON, and nothing else, to the file tmp/chef/scratch/${issue}-critique.json of the main checkout (the parent directory of the output of \`git rev-parse --path-format=absolute --git-common-dir\`), creating the directory if it is absent: ${JSON.stringify(critiqued)}`,
      `Then run \`bun scripts/chef/design-critique.ts write ${issue} --input <that absolute path>\` once. Return exitCode (its exit code) and error (its output when the exit code is not 0).`,
    ].join('\n'),
    {
      label: `resolve ${issue}`,
      phase: 'critique',
      schema: RESOLVE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
  if (written === null) return judgment(issue, 'rows.resolved.json step failed', steps);
  steps.resolve = written;
  if (written.exitCode !== 0)
    return judgment(
      issue,
      `rows.resolved.json refused: ${written.error || `exit ${written.exitCode}`}`,
      steps,
    );
  return null;
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
      'Otherwise run `bun scripts/chef/focused-checks.ts` once, with its output redirected to a file under tmp/ in that worktree, in the background if it runs long, and wait for it to exit. Never rerun it. Return exitCode (its exit code), line (the last non-empty line of that file), head, and pending: for every line of the file that starts `focused-checks: <step>: pending` and names a command after `run it directly: `, that command, verbatim (an empty array when there is none).',
      `Then, from the same worktree, run \`bun scripts/chef/report.ts check ${issue} --head ${head}\` once and read its JSON: return reportOk (its ok, false when it printed nothing) and reportProblems (its problems). It verifies that the worker's report exists, is valid, names the current brief version, lists every correction, was not recorded through the three-blocks escape, and is for this head.`,
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

/** Runs the stages the focused checks left pending, each once, without the pool-wait bound. */
function runPending(issue, worktree, branch, head, commands) {
  log(`${issue}: running ${commands.length} pending stage(s) directly at ${head}`);
  return agent(
    [
      `Run the pending focused-check stages of ${issue} at head ${head}. Invoke no skills. Change nothing in the repository.`,
      `cd ${worktree}. Run \`git fetch origin ${branch}\` and confirm \`git rev-parse HEAD\` equals ${head}; if it differs, return the head you found and no results.`,
      'Run each command below once, from that directory, with its output redirected to a file under tmp/ there, in the background, and wait for it to exit; never rerun one and never add a wait of your own. Return head and results: each command, verbatim, with its exit code.',
      ...commands.map((command) => `- ${command}`),
    ].join('\n'),
    {
      label: `pending ${issue}`,
      phase: 'check',
      schema: PENDING_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

// A pending stage that runs and still is not admitted (or hits the hang guard) gave no verdict.
const PENDING_NOT_RUN = [70, 75, 76];

/** The failed-step count of a focused-checks summary line, or null when it names none. */
function failedSteps(line) {
  const match = /\b(\d+) failed\b/.exec(typeof line === 'string' ? line : '');
  return match === null ? null : Number(match[1]);
}

/**
 * Focused checks that exit non-zero with no failed step gave no verdict: a pending stage is run
 * directly, and a hung or killed step goes to the coordinator. Neither is a defect, so neither
 * opens a correction. Returns null when a step failed (an ordinary finding), { findings } after
 * the pending stages ran, or a judgment.
 */
async function noVerdict(issue, checks, where, steps, evidence) {
  if (checks.exitCode === 0 || failedSteps(checks.line) !== 0) return null;
  const commands = (Array.isArray(checks.pending) ? checks.pending : []).filter(
    (command) => typeof command === 'string' && command.trim() !== '',
  );
  const stop = (why) =>
    judgment(
      issue,
      `focused checks gave no verdict (${why}); that is not a defect, so no correction was opened`,
      steps,
      where,
    );
  if (/\bhung\b|killed by a signal/.test(checks.line) || commands.length === 0)
    return stop(checks.line);
  const ran = await runPending(issue, where.worktree, where.branch, where.head, commands);
  if (ran === null) return judgment(issue, 'pending stage step failed', steps, where);
  evidence.pending = ran;
  if (ran.head !== where.head)
    return judgment(issue, `pending stages ran at ${ran.head}, not ${where.head}`, steps, where);
  const results = Array.isArray(ran.results) ? ran.results : [];
  const result = (command) => results.find((entry) => entry.command === command);
  const unrun = commands.filter(
    (command) => !result(command) || PENDING_NOT_RUN.includes(result(command).exitCode),
  );
  if (unrun.length > 0) return stop(`still not run: ${unrun.join('; ')}`);
  return {
    findings: commands
      .filter((command) => result(command).exitCode !== 0)
      .map(
        (command) =>
          `pending check \`${command}\` failed when run directly (exit ${result(command).exitCode})`,
      ),
  };
}

/**
 * Fetches the default branch. When it has moved past the brief's base, the same step says whether
 * the base is its ancestor and reads the issue body digest of the brief on disk and of a fresh
 * `--stdout` brief, so a moved base is accepted unless the issue itself changed.
 */
function fetchDispatchBase(issue, briefBase, briefPath, run) {
  phase('brief');
  const runFlag = typeof run === 'string' && run !== '' ? ` --run ${run}` : '';
  return agent(
    [
      'Read the configured defaultBranch from scripts/chef/repository.json in this checkout.',
      'Fetch it with `git fetch --no-tags origin "refs/heads/<default>:refs/remotes/origin/<default>"`, substituting that branch name in both places.',
      'If the fetch succeeds, return exitCode 0 and base from `git rev-parse --verify refs/remotes/origin/<default>`. If either command fails, return its nonzero exitCode and error. Change no files and leave the checkout where it is.',
      `If that base is not ${briefBase}, also run \`git merge-base --is-ancestor ${briefBase} <that base>\` and return ancestor true when it exits 0, false otherwise; return briefDigest, the value of the \`Issue body digest:\` line of the file ${briefPath}; and run \`bun scripts/chef/brief.ts ${issue} --stdout${runFlag}\` once and return currentDigest, the value of the \`Issue body digest:\` line it prints. Leave out a value you could not read.`,
    ].join('\n'),
    {
      label: `fetch base ${issue}`,
      phase: 'brief',
      schema: FETCH_BASE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

function dispatchEvidence(issue, worktree, branch, head, reviewReference) {
  phase('evidence');
  const decisionName = `${issue}-${head}.json`;
  log(`${issue}: approved discretionary CI for ${head} after local review`);
  return agent(
    [
      `Dispatch the evidence run of ${issue}. Invoke no skills. Change nothing in the repository.`,
      `cd ${worktree}. Run \`git fetch origin main ${branch}\` and confirm \`git rev-parse HEAD\` equals ${head}; if it differs, return dispatched false and an error.`,
      'First run `bun scripts/chef/targeted-run.ts --dry-run --json` and read ref, inputs, command and requiresFullRun (treat an absent requiresFullRun as false). If requiresFullRun is true, dispatch nothing: return dispatched false with those fields.',
      `The coordinator accepted the local review. Use git rev-parse --path-format=absolute --git-common-dir to find the main checkout (the parent of the common .git directory). Create tmp/chef/discretionary-ci there and use ${decisionName} in that directory as the absolute decisionFile.`,
      `Record approval with bun scripts/chef/targeted-run.ts --approve <decisionFile> --head ${head} --review-ref <reference>, passing ${JSON.stringify(reviewReference)} as the literal review reference. Then run bun scripts/chef/targeted-run.ts --decision <decisionFile> --json once. Use the same ref and lane options for the plan, approval and dispatch.`,
      'Read the run ID from the dispatch receipt. If GitHub returned no ID or URL, list the targeted workflow runs for the exact ref and head, and accept only a single run created since the recorded decisionFile.attempt time. Read the chosen run again with gh run view <id> --json headSha. If its identity is uncertain, return dispatched false with the problem and decisionFile. Return dispatched true, runId, headSha, url, decisionFile, ref, inputs, command and requiresFullRun.',
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

/**
 * The acceptance review of every candidate: the read-only contract check. Its contract is the
 * issue's own sections of the brief; its range starts where the worker started (or at the default
 * branch for a coordinator-requested correction, which has no recorded start).
 */
function review(issue, where, base, briefPath) {
  phase('review');
  log(`${issue}: checking ${where.branch} at ${where.head} against its contract`);
  const contract =
    typeof briefPath === 'string' && briefPath !== ''
      ? briefPath
      : `tmp/chef/briefs/${issue}.md in the main checkout (the parent directory of the output of \`git rev-parse --path-format=absolute --git-common-dir\`)`;
  return agent(
    [
      `Check branch ${where.branch} of ${issue} at head ${where.head} against its contract. cd ${where.worktree} and confirm \`git rev-parse HEAD\` is ${where.head}; change nothing.`,
      `The contract is the issue's own sections of the brief file ${contract}: its brief, criteria, decisions, out of scope, constraints, files, verification and delivery boundary. The charter rules and coordinator sections are not contract.`,
      `The diff is \`git diff ${base}...${where.head}\`.`,
      'Return status conforms or departures, each departure as one line (the contract line and the diff location), each unverifiable criterion as one line, and evidencePath: the reference to cite for this check (the diff range and head).',
    ].join('\n'),
    { label: `review ${issue}`, phase: 'review', schema: VERDICT, agentType: 'stickler' },
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

/** Haiku runs the classifier script; the class names are the script's, never a model's own. */
function classify(issue, branch, findings, pullRequest) {
  return agent(
    [
      `Classify the findings of ${issue} into defect classes. Invoke no skills. Change nothing in the repository.`,
      'For each finding below run `bun scripts/chef/review-threads.ts tag --text <the finding, as one shell argument>` and return the union of the "classes" it prints as classes.',
      pullRequest
        ? `Then run \`bun scripts/chef/review-threads.ts classes --pr ${pullRequest} --json\` (exit 1 is a normal result) and return its "repeating" array as seenOnBranch.`
        : 'There is no pull request: return seenOnBranch as an empty array.',
      ...findings.map((finding) => `- ${finding}`),
    ].join('\n'),
    {
      label: `classify ${issue}`,
      phase: 'correct',
      schema: CLASSIFY_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

/** Every correction, point fix or class fix, from the branch path or a coordinator, is this step. */
function correct(issue, where, findings, model, kind, classes, briefPath) {
  phase('correct');
  const classFix = kind === 'CLASS_FIX';
  log(`${issue}: ${kind} of ${findings.length} finding(s) at ${where.head}`);
  const brief =
    typeof briefPath === 'string' && briefPath !== ''
      ? `The brief file is ${briefPath}`
      : `The brief file is tmp/chef/briefs/${issue}.md in the main checkout`;
  return agent(
    [
      `cd into ${where.worktree}, the worktree of branch ${where.branch}, at the pre-fix head ${where.head}. ${brief}: read it again, and the unread corrections for ${issue} in the main checkout's tmp/chef/execution-state/corrections/${issue}.jsonl (an amendment recorded after the first worker stopped is delivered here). Fix these findings and the amendments, and only these:`,
      ...findings.map((finding) => `- ${finding}`),
      classFix
        ? `These findings repeat a defect class already seen on this branch (${classes.join(', ')}), so a point fix is refused. Your criterion is a test that enumerates every entry point of that class (every route, every exported boundary, every hook it can reach), not the one instance, and fails today. Return entryPoints: the entry points that test covers.`
        : 'Fix the instance the findings name.',
      `Write the regression test first and run it on ${where.head}: it must fail there. Then fix, run \`bun scripts/chef/focused-checks.ts\`, write your report again with \`bun scripts/chef/report.ts write ${issue} --file <json in your scratch directory> --brief-version <the Brief version: line of the brief as you read it>\` (list every correction you read in correctionsRead), commit the ledger, push the branch ${where.branch} once, and return the new head and regressionTest: path (the test file), failsOn (${where.head}) and passesOn (the new head). Never edit a test to make it pass. A hook refuses your stop without a valid report. ${NO_MERGE}`,
    ].join('\n'),
    {
      label: `${classFix ? 'class-fix' : 'correct'} ${issue}`,
      phase: 'correct',
      schema: CORRECTION_SCHEMA,
      agentType: 'chef-worker',
      model: model,
    },
  );
}

function pinRegression(issue, where, regressionTest) {
  return agent(
    [
      `Prove the regression test ${regressionTest.path} of ${issue} fails before the fix and passes after it. Invoke no skills. Change nothing in the repository.`,
      `cd ${where.worktree} and run \`git fetch origin ${where.branch}\`. Do this once for ${regressionTest.failsOn} and once for ${regressionTest.passesOn}: \`git worktree add --detach <a new path under tmp/> <sha>\`; in it run \`bun install --frozen-lockfile\`; for the pre-fix sha copy the test file from the new sha with \`git show ${regressionTest.passesOn}:${regressionTest.path}\`; run \`CORVIDAE_TEST_POOL_WAIT_SECONDS=300 bun scripts/bun-test.ts ${regressionTest.path}\` there, and record its exit code and \`git rev-parse HEAD\` there; then \`git worktree remove --force\` that path.`,
      `Return priorExitCode and priorHead (the run at ${regressionTest.failsOn}), priorOutput (that run's output, verbatim: the file header line and every (fail) line) and newExitCode and newHead (the run at ${regressionTest.passesOn}). Report a setup failure as its real exit code; never turn it into 1.`,
    ].join('\n'),
    {
      label: `pin ${issue}`,
      phase: 'correct',
      schema: PIN_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  );
}

/**
 * The one correction path. Classifies the findings against the classes seen so far, runs a point
 * fix or (on a repeated class) a CLASS_FIX, and refuses unless the returned test is proven to fail
 * on the pre-fix head and pass on the new one. Returns { head } or { done: <judgment> }.
 */
async function runCorrection(context, where, findings, key) {
  const { issue, steps, state, chosen } = context;
  const stop = (reason, extra) => ({
    done: judgment(issue, reason, steps, { ...where, findings, ...extra }),
  });
  const classified = await classify(issue, where.branch, findings, state.pullRequest);
  if (classified === null) return stop('classify step failed');
  const classes = [...new Set([...classified.classes, ...state.named])];
  const repeated = classes.filter(
    (name) => state.seen.has(name) || classified.seenOnBranch.includes(name),
  );
  for (const name of classes) state.seen.add(name);
  const kind = repeated.length > 0 ? 'CLASS_FIX' : 'POINT_FIX';
  state.named = [];
  const record = { kind, classes, repeated };
  steps[key] = record;
  const fixed = await correct(
    issue,
    where,
    findings,
    chosen.model,
    kind,
    repeated,
    context.briefPath,
  );
  if (fixed === null) return stop('correction failed');
  record.fixed = fixed;
  if (fixed.status !== 'ready-for-review')
    return stop(`correction ${fixed.status}: ${fixed.report}`);
  const test = fixed.regressionTest;
  if (
    !test ||
    typeof test.path !== 'string' ||
    !TEST_FILE.test(test.path) ||
    test.failsOn !== where.head ||
    test.passesOn !== fixed.head ||
    fixed.head === where.head
  )
    return stop(
      `correction refused: no failing-first regression test (a test file, failing on ${where.head}, passing on the new head)`,
    );
  if (kind === 'CLASS_FIX' && !(Array.isArray(fixed.entryPoints) && fixed.entryPoints.length > 0))
    return stop(
      'class fix refused: its test must enumerate every entry point of the class, and none were listed',
    );
  const pin = await pinRegression(issue, where, test);
  if (pin === null) return stop('regression test pin step failed');
  record.pin = pin;
  const problem = pinProblem(pin, test);
  if (problem !== null) return stop(problem);
  return { head: fixed.head };
}

/** The structured result the coordinator lands from: only facts a step returned. */
function evidenceRequest(issue, run, built, head, evidence, verdict, override, chosen) {
  return {
    workerModel: { model: chosen.model, rule: chosen.rule },
    issue,
    run: run === undefined ? null : run,
    repository: REPOSITORY,
    startingBase: normalizeCommitSha(built.startingBase),
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
    review: {
      verdict: verdict.status,
      evidencePath: verdict.evidencePath,
      unverifiable: Array.isArray(verdict.unverifiable) ? verdict.unverifiable : [],
    },
    override: override === null ? null : override,
  };
}

function verifyBlockers(evidence) {
  const blockers = [];
  if (evidence.checks.exitCode !== 0)
    blockers.push(`focused checks failed: ${evidence.checks.line}`);
  return blockers;
}

function coordinatorBrief(records, issue) {
  const record = records && Object.hasOwn(records, issue) ? records[issue] : null;
  if (
    !record ||
    record.validated !== true ||
    !Number.isInteger(record.exitCode) ||
    typeof record.briefPath !== 'string'
  )
    return null;
  return record;
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
  let prepared = coordinatorBrief(args && args.preparedBriefs, issue);
  if (prepared === null)
    return judgment(issue, 'missing validated coordinator brief; no worker', steps);
  steps.brief = prepared;
  // An issue with design rows is briefed only after its critique: one critique, one re-brief. An
  // issue without design rows adds no call here.
  if (prepared.exitCode !== 0 && prepared.needsResolvedRows === true) {
    const failure = await resolveRows(issue, steps, context);
    if (failure !== null) return failure;
    prepared = coordinatorBrief(args && args.resolvedBriefs, issue);
    if (prepared === null)
      return judgment(issue, 'missing validated coordinator brief after the critique', steps);
    steps.rebrief = prepared;
  }
  let briefPath = prepared.briefPath.trim();
  let briefBase = normalizeCommitSha(prepared.base);
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
    const written = coordinatorBrief(args && args.overrideBriefs, issue);
    if (
      written === null ||
      written.exitCode !== 0 ||
      !Number.isSafeInteger(written.bytes) ||
      written.bytes <= 0 ||
      !written.briefPath.startsWith('/') ||
      !written.briefPath.endsWith(`/tmp/chef/briefs/${issue}.md`)
    )
      return judgment(issue, 'override produced no brief; no worker', steps);
    steps.overrideBrief = written;
    briefPath = written.briefPath;
    briefBase = normalizeCommitSha(written.base);
    log(`${issue}: brief override recorded: ${override.reason}`);
  } else if (!briefPath.startsWith('/')) {
    return judgment(issue, 'brief exited 0 without an absolute brief path', steps);
  }

  if (briefBase === undefined)
    return judgment(issue, 'validated brief has no pinned base SHA', steps);
  const fetched = await fetchDispatchBase(issue, briefBase, briefPath, run);
  steps.fetchBase = fetched;
  if (fetched === null || fetched.exitCode !== 0)
    return judgment(
      issue,
      `could not fetch the default branch: ${fetched?.error || 'base fetch failed'}`,
      steps,
    );
  const fetchedBase = normalizeCommitSha(fetched.base);
  if (fetchedBase === undefined)
    return judgment(issue, 'fetch of the default branch did not return a commit SHA', steps);
  // A moved base needs no new evidence run (owner decision, 2026-11-21): the brief stands while its
  // base is an ancestor of the fetched branch and the issue body is unchanged.
  if (fetchedBase !== briefBase) {
    if (fetched.ancestor !== true)
      return judgment(
        issue,
        `validated brief pins ${briefBase}, which is not an ancestor of the fetched default branch ${fetched.base}. Prepare a fresh brief.`,
        steps,
      );
    const digests = [fetched.briefDigest, fetched.currentDigest];
    if (digests.some((value) => typeof value !== 'string' || value.trim() === ''))
      return judgment(
        issue,
        'the default branch moved and the issue body digest could not be compared. Prepare a fresh brief.',
        steps,
      );
    if (fetched.briefDigest.trim() !== fetched.currentDigest.trim())
      return judgment(
        issue,
        `the issue body changed since the brief (digest ${fetched.briefDigest} became ${fetched.currentDigest}). Prepare a fresh brief.`,
        steps,
      );
    log(`${issue}: default branch moved to ${fetched.base}; the brief's base is its ancestor`);
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
    [
      `Before editing, run \`git rev-parse --verify HEAD\` in your assigned worktree and record the result as startingBase. If it differs from ${briefBase}, make no changes and return status blocked, the observed SHA as both startingBase and head, the assigned branch and worktree path, and a report explaining the mismatch.`,
      `Implement the issue from the brief file ${briefPath} and nothing else. This is the branch path: push your branch, open no pull request, and return startingBase, the pushed head, the branch name and your worktree path. ${NO_MERGE}`,
    ].join('\n'),
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
  if (normalizeCommitSha(built.startingBase) !== briefBase)
    return judgment(
      issue,
      `worktree started at ${built.startingBase}; expected fetched base ${briefBase}`,
      steps,
      {
        head: built.head,
        branch: built.branch,
        worktree: built.worktree,
      },
    );
  if (built.status !== 'ready-for-review')
    return judgment(issue, `worker returned ${built.status}: ${built.report}`, steps, {
      head: built.head,
      branch: built.branch,
      worktree: built.worktree,
    });

  const loop = {
    issue,
    run,
    built,
    chosen,
    overridden,
    steps,
    briefPath,
    state: correctionState(issue, null, []),
  };
  let head = built.head;
  for (let round = 1; round <= MAXIMUM_ROUNDS; round += 1) {
    const verified = await verifyRound(loop, head, round, `round${round}`);
    if (verified.status !== undefined) return verified;
    const where = { head, branch: built.branch, worktree: built.worktree };
    if (round === MAXIMUM_ROUNDS)
      return judgment(issue, `still failing after ${round - 1} correction`, steps, {
        ...where,
        findings: verified.findings,
      });
    const corrected = await runCorrection(loop, where, verified.findings, `correction${round}`);
    if (corrected.done) return corrected.done;
    head = corrected.head;
  }
  return judgment(issue, 'no round ran', steps, {});
}

/** Per issue: the pull request (if any), the classes seen so far, and a class the coordinator named. */
function correctionState(issue, pullRequest, seen, named) {
  const pullRequests = args && args.pullRequests;
  return {
    pullRequest:
      pullRequest !== null
        ? pullRequest
        : pullRequests && Object.hasOwn(pullRequests, issue)
          ? pullRequests[issue]
          : null,
    seen: new Set(seen),
    named: named === undefined ? [] : named,
  };
}

/**
 * One verification round of a head: checks, review, evidence run, wait, compare. Returns a
 * READY_TO_LAND or NEEDS_JUDGMENT result (it has a status), or { findings } to correct.
 */
async function verifyRound(context, head, round, key) {
  const { issue, run, built, chosen, overridden, steps } = context;
  {
    const where = { head, branch: built.branch, worktree: built.worktree };
    const evidence = {};
    steps[key] = evidence;

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
    // A report that does not stand for the pushed head never lands: no evidence is dispatched.
    if (checks.reportOk !== true)
      return judgment(
        issue,
        `the worker report does not stand: ${(checks.reportProblems || ['no report check result']).join('; ')}`,
        steps,
        where,
      );
    const unsettled = await noVerdict(issue, checks, where, steps, evidence);
    if (unsettled !== null && unsettled.status !== undefined) return unsettled;
    let findings = unsettled === null ? verifyBlockers(evidence) : unsettled.findings;

    if (findings.length === 0) {
      const verdict = await review(
        issue,
        where,
        normalizeCommitSha(built.startingBase) ?? 'origin/main',
        context.briefPath,
      );
      if (verdict === null) return judgment(issue, 'local review failed', steps, where);
      evidence.review = verdict;
      if (verdict.status !== 'conforms')
        return {
          findings:
            Array.isArray(verdict.departures) && verdict.departures.length > 0
              ? verdict.departures
              : ['the contract check reported departures without naming them'],
        };
      if (!verdict.evidencePath?.trim())
        return judgment(issue, 'local review did not return an evidence reference', steps, where);
      const dispatch = await dispatchEvidence(
        issue,
        built.worktree,
        built.branch,
        head,
        verdict.evidencePath,
      );
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
    }

    return { findings };
  }
}

/**
 * args.correction = { issue, head, branch, worktree, finding, class?, pr?, seenClasses? }: a
 * correction the coordinator asks for. It skips the brief and the build and runs the one
 * correction path, then the checks, review, evidence and compare steps for the new head.
 */
async function correctOne(request) {
  const issue = request && request.issue;
  const text = (value) => typeof value === 'string' && value.trim() !== '';
  const findings = Array.isArray(request && request.finding)
    ? request.finding
    : [request && request.finding];
  if (
    !text(issue) ||
    !text(request.head) ||
    !text(request.branch) ||
    !text(request.worktree) ||
    !findings.every(text)
  )
    return judgment(
      text(issue) ? issue : 'unknown',
      'invalid correction: it needs issue, head, branch, worktree and finding',
      {},
    );
  if (request.class !== undefined && !CLASS_NAMES.includes(request.class))
    return judgment(issue, `invalid correction: ${request.class} is not a defect class`, {});
  const steps = {};
  const built = { branch: request.branch, worktree: request.worktree };
  const paths = args && args.paths && Array.isArray(args.paths[issue]) ? args.paths[issue] : [];
  const chosen = chooseModel(issue, paths);
  steps.model = chosen;
  const context = {
    issue,
    run: args && args.run,
    built,
    chosen,
    overridden: null,
    steps,
    briefPath: text(request.briefPath) ? request.briefPath : undefined,
    state: correctionState(
      issue,
      request.pr === undefined ? null : request.pr,
      Array.isArray(request.seenClasses) ? request.seenClasses : [],
      request.class === undefined ? [] : [request.class],
    ),
  };
  const where = { head: request.head, branch: request.branch, worktree: request.worktree };
  const corrected = await runCorrection(context, where, findings, 'correction1');
  if (corrected.done) return corrected.done;
  const verified = await verifyRound(context, corrected.head, 1, 'verify');
  if (verified.status !== undefined) return verified;
  return judgment(issue, 'the corrected head still has findings', steps, {
    head: corrected.head,
    branch: request.branch,
    worktree: request.worktree,
    findings: verified.findings,
  });
}

const issues = Array.isArray(args && args.issues) ? args.issues : [];
if (args && args.correction) {
  return [await correctOne(args.correction)];
}
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
