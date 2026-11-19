#!/usr/bin/env bun
// Chef brief: turns one Linear issue into a compact brief file, so the coordinator starts one fresh
// session per issue from a short, self-contained document instead of a long-lived session that
// carries a stream's whole history. On the 2026-10-22 run, long-lived stream sessions averaged
// about 470K tokens of context per call, and about 88% of the spend was re-reading it.
//
// Usage:
//   bun scripts/chef/brief.ts <ID> [<ID>...] [--path <file>]... [--verify <command>]...
//                             [--model <name>] [--repository <name> --base <sha>]
//                             [--classification <behavior|no-behavior>] [--context <json>]
//                             [--run <id>] [--out-dir <dir>] [--stdout] [--json]
//
// Several IDs write one batch brief (owner decision, 2026-11-16: batch work, one CI run per batch)
// to `<IDs joined by _>.md`: each issue keeps its own heading with its criteria, blockers and
// claim, in the given order; the files, verification, scratch directory and charter rules follow
// once. A native dependency remains open until Linear reports completed evidence.
//
// It reads the issue with `linear.ts`'s client and writes `<main checkout>/tmp/chef/briefs/<ID>.md`
// (gitignored; `--out-dir` replaces the directory), or with `--stdout` prints the brief and writes
// nothing (a read-only scout needs no checkout and no directory; it still needs the Linear key).
// The brief ends with its size in bytes. It holds:
//   - shared programme text, replaced by its link: a section whose heading says it is shared (see
//     `sharedHeading`) and that links the document holding it keeps its heading and a one-line
//     pointer, so a programme's preamble is read once, in the document, not in every brief;
//   - the issue's brief (an "Execution brief" or "Brief" heading) followed by its Current behavior,
//     Acceptance criteria, Decisions, Out of scope, Constraints and Delivery boundary sections and
//     every dated revision, or the whole description when it has no brief heading;
//   - when the issue names a design (a claude.ai artifact link or a "Design source" section): the
//     design rows, the rows its acceptance criteria leave out, and the instruction to build against
//     the saved boards and return a design-review verdict per row;
//   - the open blockers: every blocked-by issue whose state type is not `completed`, or "None", or
//     why the relations could not be read;
//   - the claim: the issue's newest claim comment (`linear.ts claim`) as one line, or "None". A
//     live claim by a run other than `--run` (or any live claim, without `--run`) is exit 1 and no
//     brief is written; `--stdout` still prints it, since a read-only scout takes no claim;
//   - the files: each `--path`, else the "Files" section, else the path-like code spans in the
//     description;
//   - the verification commands: coordinator-approved `--verify` commands, or the focused checks
//     for what the worker changed; issue Verification prose is never executable authority;
//   - the charter rules every worker gets (`charterRules` below, their one source; the
//     `references/execution-record.md` "Worker charter" template points here): cost, checks,
//     browser suites on CI only, the scratch directory, branch updates, delivery, the review
//     rounds, the turn rule, the defect-class self-check, context, the report, corrections, and
//     acceptance-criteria statuses;
//   - the scratch directory: a written brief gets its own `<issue>-<short id>` directory under the
//     main checkout's `tmp/chef/scratch/` (under `<out-dir>/scratch` with `--out-dir`), created by
//     this script, so two workers never share logs. `--stdout` creates none.
//
// The script only prepares the brief. The coordinator tool starts the session: one fresh session
// per issue, on Sonnet unless the brief names a reason for another model, from this file, and the
// session ends when its change merges (by pull request or by a direct merge of its pushed branch).
// Never reuse a session for the next issue.
//
// Exit codes: 0 brief written, 1 issue not found or API failure, 2 invalid CLI usage.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Blocker,
  claimIsLive,
  createClient,
  describeClaim,
  fetchComments,
  fetchIssue,
  type IssueSummary,
  latestClaim,
  type LinearDependencies,
  LinearError,
  openBlockers,
} from './linear.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { volatileImagePaths } from './report-schema.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import {
  type Assignment,
  type AssignmentGate,
  assignmentVersion,
  createVerificationPlan,
  criterionRecords,
  digest,
  gateAssignment,
  type VerificationPlan,
} from './verification-plan.ts';

export { UsageError };

/**
 * The push rule (COR-2464): a restart that strands a worker must leave its commits on the remote.
 * The agent definitions restate its key phrase, and `brief.test.ts` pins both.
 */
export const pushRule =
  'after every commit, push your own branch to origin (`git push origin HEAD:<your branch>`), never to `main`, and do not wait for the focused checks before that push (they still gate ready-for-review); run the revert check before each push. After the final push run `gh workflow run main.yml --ref <branch>` once per batch, record its returned run ID in the ready-for-review receipt, and do not wait for it.';

/**
 * The delivery shape, stated once: every brief carries this sentence, and no other worker-facing
 * document restates it (`brief.test.ts` checks the agent definition and the Codex protocol).
 */
export const deliveryRule =
  'push your branch and report, and open no pull request unless the dispatch asks for one; you do not merge, because the coordinator verifies and merges your branch (or a pull request through `deliver.ts`); on a conflict, merge `main` in, rerun the focused checks, and return the new head; a red `main` is a warning, not a refusal; and this rule outranks any delivery wording in the issue.';

/**
 * The charter rules: the one source of the worker-facing rules. `brief.test.ts` keeps each in step
 * with the AGENTS.md rule it restates and keeps `references/execution-record.md` from restating them.
 */
export const charterRules = [
  '**Cost:** batch independent reads and searches into one message. Edit with Edit or Write, never a shell heredoc (a throwaway codemod for a mechanical multi-file rewrite is the exception).',
  '**Checks:** local checks run only direct tests (owner decision, 2026-11-16). Run the focused checks on what you changed once, when the change is complete, in the background and never polled, not `bun run check` and never the affected-test graph: `bun scripts/chef/focused-checks.ts`; fix every failed step, and never rerun it until green. It runs prettier on the changed files, `bun run lint:root`, the root type-check when root or `scripts/` files changed, lint and type-check of each changed workspace, and only the test files of what you changed: changed `*.test.ts` files, plus the test files beside each changed source file (same directory, same stem). A test file that starts a process is named `*.integration.test.ts`; it and `*.slow.test.ts` files in that set run the way the isolated lane does. The full test evidence is CI on the pushed branch, run once per batch with `gh workflow run main.yml --ref <branch>` and never waited on by you; the full suite only for a one-way door, the lock or concurrency infrastructure, or `turbo.json` and the root scripts, never a local `bun run validate`. Delivery runs no gate.',
  "**Browser suites:** never run a Playwright fixture suite, the Interborough end-to-end suite, a design-review capture (the coordinator runs it for your design rows), `validate` or `harden` on this host (owner decision, 2026-11-13). When your change reaches a browser suite, push, run `gh workflow run main.yml --ref <branch>` once per branch, on its final head, and `bun scripts/chef/targeted-run.ts` (`targeted-checks.yml`, inputs derived from your diff) for each correction round, and do not wait on it (owner decision, 2026-11-16); a coordinator waits with `bun scripts/chef/wait-run.ts <run id>`, never `gh run watch`, which drained the API limit. Before any re-run, read the failing test names and download the failing shard's artifact: a re-run makes the first attempt's artifact unreachable.",
  '**Processes:** never end a process by name or pattern (`pkill`, `killall`, `kill` of a pid you did not start): a worker ends only a process it started, by pid.',
  '**Scratch:** keep your logs and temporary files only in the scratch directory this brief names under `## Scratch directory`, never in `/tmp` or any path another worker can write.',
  `**Push:** ${pushRule}`,
  '**Branch:** update from `main` only by a real merge (`git fetch origin main && git merge FETCH_HEAD`), never `git reset --soft` onto a newer `main`. Before every push, run `bun scripts/chef/revert-check.ts` and read `git diff --name-only origin/main...HEAD`; a file you did not mean to change means a stale tree.',
  `**Delivery:** ${deliveryRule}`,
  '**Review rounds, with a pull request open (AGENTS.md "Review guidelines"):** answer every thread before merge; at most three rounds; round one fixes every real finding; rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; then open items go to one follow-up issue; push once per round, because Codex reviews every push automatically; do not re-answer a re-reported comment.',
  '**Turn rule:** end a turn only on a state change: merged, blocked, needs-decision, or ready-for-review. Wait on a completion; never poll, and never end a turn to say you are still waiting.',
  '**Defect-class self-check:** before pushing, check the diff against every class in `.agents/skills/chef/references/defect-classes.md` and report each. With a pull request open, run `bun scripts/chef/review-threads.ts classes --pr <n>` before every fix push; on exit 1, push nothing more and return blocked.',
  '**Context:** there is no context ceiling; work until the change is complete and verified. Keep context small anyway: write long output to a file and read its tail.',
  '**Report:** before you stop, write your report file with `bun scripts/chef/report.ts write <brief stem> --file <json in your scratch directory>` (the brief version above is added for you; list the ids of every correction you read in `correctionsRead`) and commit the criteria ledger it writes under `documentation/criteria-ledger/`; a hook refuses your stop without a valid report. Your final message is the report, at most 15 lines; create no `report.md`. Lines: `status:`, `pr:` (or none), `head:`, `worktree:`, `checks:` (command and exit code), `revert check:`, `changed files:`, `not verified:`, `decisions:`, and each acceptance criterion with its status. Evidence for the coordinator goes under `tmp/chef/<package>/round-<n>/` in the main checkout. Keep the PIDs of every background process you start. Your final step runs `bun scripts/chef/leftovers.ts --worktree <owned-worktree> --pids <owned-pid,...>` and quotes its line; a live owned PID is a reported charter defect, never a clean handoff.',
  '**Corrections:** after two unsuccessful attempts at the same defect or acceptance criterion, stop patching and return evidence for causal reassessment.',
  '**Acceptance criteria:** give every criterion exactly one status in the return. Implemented: not yet checked. Verified: a named command passed or a manual check was done. Failed: a check failed. Blocked: an external dependency prevents checking. Not verified: not checked, with the reason. Criteria include dated revisions and amending comments; a conflict between them is needs-decision. Number unnumbered criteria AC1, AC2 in the return only.',
];

const rootLint = 'bun run lint:root';
const focusedChecks = 'bun scripts/chef/focused-checks.ts';

/** Whether a verification list already runs the root lint, directly or through `focused-checks.ts`. */
const runsRootLint = (text: string) => text.includes(rootLint) || text.includes(focusedChecks);

const defaultVerification = [focusedChecks];

/**
 * The verification list: the explicit commands, or the defaults when there are none. The
 * default `focused-checks.ts` runs the root lint itself; explicit commands get it appended,
 * because its guards scan the tests of every workspace, so a change inside one workspace can
 * fail it.
 */
export function verificationCommands(explicit: string[]): string[] {
  if (explicit.length === 0) return defaultVerification;
  return explicit.some(runsRootLint) ? explicit : [...explicit, rootLint];
}

/** The body of the description section whose heading matches `heading`, or `undefined`. */
export function sectionOf(description: string, heading: RegExp): string | undefined {
  const lines = description.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index] ?? '');
    if (match === null || !heading.test(match[2] ?? '')) continue;
    const level = (match[1] ?? '').length;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = /^(#{1,6})\s/.exec(lines[next] ?? '');
      if (following !== null && (following[1] ?? '').length <= level) break;
      body.push(lines[next] ?? '');
    }
    const text = body.join('\n').trim();
    if (text !== '') return text;
  }
  return undefined;
}

/** Code spans in `text` that look like repository paths: a slash and a file extension. */
export function pathsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    const candidate = (match[1] ?? '').replace(/:\d+(?::\d+)?$/, '');
    if (/^[\w@.~-]+(?:\/[\w@.~*-]+)+\.\w+$/.test(candidate)) found.add(candidate);
  }
  return [...found];
}

/**
 * The design index rows a description names, in first-seen order: bold IDs such as `**11a**`
 * and IDs that lead a list item or criterion (`- 04f:`, `- [ ] 11a:`).
 */
export function designRowIds(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\*\*(\d{2}[a-z])\*\*|^\s*[-*]\s+(?:\[[ xX]\]\s+)?(\d{2}[a-z])\b/gm;
  for (const match of text.matchAll(pattern)) found.add(match[1] ?? match[2] ?? '');
  found.delete('');
  return [...found];
}

/** The claude.ai artifact links (design canvases) a description names, once each. */
export function designLinks(text: string): string[] {
  return [...new Set(text.match(/https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+/g) ?? [])];
}

/**
 * The design section of a brief, or nothing when the issue names no design. It carries the rows
 * even when an execution-brief heading would otherwise hide them, names the rows the acceptance
 * criteria leave out, and tells the worker to build against the boards and to get a design-review
 * verdict for every row before the pull request is ready.
 */
/** Whether `text` names design row `id` as a whole token (`11a`, not `211a` or `11ab`). */
export function mentionsRow(text: string, id: string): boolean {
  return new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(text);
}

/** Every heading-delimited section of a description, in order, with nested headings folded in. */
function sectionsOf(description: string): { heading: string; body: string }[] {
  const lines = description.split('\n');
  const sections: { heading: string; body: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index] ?? '');
    if (match === null) continue;
    const level = (match[1] ?? '').length;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const following = /^(#{1,6})\s/.exec(lines[next] ?? '');
      if (following !== null && (following[1] ?? '').length <= level) break;
      body.push(lines[next] ?? '');
    }
    sections.push({ heading: match[2] ?? '', body: body.join('\n') });
  }
  return sections;
}

export interface RowCarriage {
  /** Rows the issue carries as acceptance criteria, after its dated revisions. */
  criteria: Set<string>;
  /** Rows the issue defers, each with the line that records the deferral and its reason. */
  deferred: Map<string, string>;
  /** Rows a dated revision moved off the issue or dropped, each with the clause that says so. */
  moved: Map<string, string>;
}

/**
 * Which of `rows` an issue carries as criteria and which it defers. A row counts as a criterion
 * when an "Acceptance criteria" section names it, and a line that says a row is deferred records
 * a deferral wherever it sits. Appended revision sections ("## Revision 2026-10-31 …") apply in
 * order, clause by clause: a clause naming a row carries it, unless the clause says the row moved,
 * was dropped or was removed, and then the issue no longer carries it.
 */
export function rowCarriage(description: string, rows: string[]): RowCarriage {
  const criteria = new Set<string>();
  const deferred = new Map<string, string>();
  const moved = new Map<string, string>();
  const sections = sectionsOf(description);
  for (const line of description.split('\n'))
    if (/\bdeferred\b/i.test(line))
      for (const row of rows) if (mentionsRow(line, row)) deferred.set(row, line.trim());
  for (const section of sections.filter((entry) => /acceptance\s+criteria/i.test(entry.heading)))
    for (const line of section.body.split('\n'))
      if (!/\bdeferred\b/i.test(line))
        for (const row of rows) if (mentionsRow(line, row)) criteria.add(row);
  // A revision line can name several rows ("now rows 11a and 19b; 12a moved"), so each clause is
  // judged on its own.
  for (const section of sections.filter((entry) => /\brevision\b/i.test(entry.heading)))
    for (const line of section.body.split(/\n|(?<=[.;])\s+/))
      for (const row of rows) {
        if (!mentionsRow(line, row) || /\bdeferred\b/i.test(line)) continue;
        if (/\b(?:moved|dropped|removed)\b/i.test(line)) {
          criteria.delete(row);
          deferred.delete(row);
          moved.set(row, line.trim());
        } else {
          criteria.add(row);
          moved.delete(row);
        }
      }
  for (const row of deferred.keys()) criteria.delete(row);
  return { criteria, deferred, moved };
}

function designLines(
  identifier: string,
  description: string,
  descriptionIncluded: boolean,
  depth = 0,
) {
  const source = sectionOf(description, /design\s+(?:source|rows?)/i);
  const links = designLinks(description);
  // Without a design section, a canvas-linked issue's rows are the IDs it names anywhere.
  const rows = designRowIds(source ?? description);
  if (source === undefined && links.length === 0) return [];
  const carriage = rowCarriage(description, rows);
  const uncovered = rows.filter(
    (row) => !carriage.criteria.has(row) && !carriage.deferred.has(row) && !carriage.moved.has(row),
  );
  return [
    `${'#'.repeat(2 + depth)} Design`,
    '',
    'This issue implements an agreed design. Its rows are requirements, not context: a departure from a board is a defect.',
    '',
    ...(links.length > 0 ? [`Canvas: ${links.join(', ')}`, ''] : []),
    ...(source !== undefined && !descriptionIncluded ? [source, ''] : []),
    ...[...carriage.deferred].flatMap(([row, line]) => [
      `Deferred on this issue, do not build: ${row} (${line})`,
      '',
    ]),
    ...[...carriage.moved].flatMap(([row, line]) => [
      `Moved off this issue by a revision, do not build: ${row} (${line})`,
      '',
    ]),
    ...(uncovered.length > 0
      ? [
          `Rows not named in the acceptance criteria: ${uncovered.join(', ')}. Treat each as a criterion; if one should not be built, stop and return needs-decision.`,
          '',
        ]
      : []),
    `- Before changing code, read every board these rows name with the Artifact tool's read action (the board's \`project/<Board>.dc.html\` path) and save it under \`tmp/chef/briefs/${identifier}/boards/\` in the main checkout. Build to the boards.`,
    "- You run no design-review capture and no `design-reviewer` (a capture never runs on the host; see **Browser suites**). Push your branch and return `ready-for-review` naming each design row you implemented with its board (the file stem you saved under `boards/`) and the screens you changed. The coordinator runs `bun scripts/design-review-capture.ts` (in `applications/interborough`, one capture at a time, under host admission, or `gh workflow run design-review-capture.yml --ref <branch>` when the host is loaded), gets each row's verdict from the read-only `design-reviewer`, checks it with `bun scripts/design-review-rows.ts`, and returns an `unverified` or failing row to you as a correction. Only `matches`, or `deferred` with the reason recorded on the issue, passes; `drifted`, `partial`, `missing` and `unverified` block acceptance.",
    '',
  ];
}

const descriptionLimit = 16_000;

/**
 * The heading of a section an issue marks as shared programme text: "Shared ...", "Programme ..."
 * or "Program ..." text, context or preamble. The rule is the heading plus a link, so a section is
 * replaced only when it points at the document that holds it.
 */
const sharedHeading =
  /^(?:shared\b|program(?:me)?\b)|\bshared\s+(?:program(?:me)?|context|text|preamble)\b|\bpreamble\b/i;

/** The first link in `text`: a URL, or a repository Markdown path in a code span or bare. */
function documentLink(text: string): string | undefined {
  return (
    /https?:\/\/[^\s)>\]]+/.exec(text)?.[0] ??
    /(?<![\w/])((?:[\w.@-]+\/)+[\w.@-]+\.md)\b/.exec(text)?.[1]
  );
}

export interface SharedStripped {
  text: string;
  /** Each section replaced by its link, with the bytes it no longer costs. */
  omitted: { heading: string; link: string; bytes: number }[];
}

/**
 * Replaces each shared programme section that links its document with a one-line pointer to the
 * link. A section without a link stays, because nothing would say where its text lives. Pure.
 */
export function stripShared(description: string): SharedStripped {
  const lines = description.split('\n');
  const kept: string[] = [];
  const omitted: SharedStripped['omitted'] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    kept.push(line);
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match === null || !sharedHeading.test(match[2] ?? '')) continue;
    const level = (match[1] ?? '').length;
    let end = index + 1;
    while (end < lines.length) {
      const following = /^(#{1,6})\s/.exec(lines[end] ?? '');
      if (following !== null && (following[1] ?? '').length <= level) break;
      end += 1;
    }
    const body = lines.slice(index + 1, end).join('\n');
    const link = documentLink(body);
    if (link === undefined) continue;
    const bytes = Buffer.byteLength(body.trim());
    omitted.push({ heading: match[2] ?? '', link, bytes });
    kept.push(
      '',
      `Shared programme text, not repeated here: ${link} (${bytes} bytes omitted).`,
      '',
    );
    index = end - 1;
  }
  return { text: kept.join('\n'), omitted };
}

/** The heading that opens an issue's brief: "Execution brief", or "Brief" alone. */
const briefHeading = /execution\s+brief|^brief$/i;

/**
 * The sections a brief carries after the issue's own brief, in this order. Each is the issue's
 * section under a matching heading; Acceptance criteria is the one that is always shown.
 */
const carriedSections: { title: string; heading: RegExp; missing?: string }[] = [
  { title: 'Current behavior', heading: /^current\s+behaviou?r\b/i },
  {
    title: 'Acceptance criteria',
    heading: /acceptance\s+criteria/i,
    missing: '(none stated; derive them from the execution brief and write them down first)',
  },
  { title: 'Decisions', heading: /^decisions?\b/i },
  { title: 'Out of scope', heading: /^out\s+of\s+scope\b/i },
  { title: 'Constraints', heading: /^constraints?\b/i },
  { title: 'Delivery boundary', heading: /^delivery\s+boundary\b/i },
];
const pathLimit = 40;

/** The issue's open blockers as read from Linear, or why they could not be read. */
export type BlockerRead = { open: Blocker[] } | { unreadable: string };

export interface BriefOptions {
  paths: string[];
  verify: string[];
  model: string;
  /** Coordinator-pinned repository identity for a dispatchable assignment. */
  repository?: string | undefined;
  /** Coordinator-pinned base revision for a dispatchable assignment. */
  base?: string | undefined;
  classification?: 'behavior' | 'no-behavior' | undefined;
  /** Coordinator-supplied verified content for required external context. */
  sourceContext?: ReadonlyMap<string, string> | undefined;
  /** Dispatch identity failures established with injected Git primitives. */
  identityErrors?: readonly string[] | undefined;
  /** Omitted when the blockers were not read; the brief then says so instead of "None". */
  blockers?: BlockerRead | undefined;
  /** `describeClaim`'s line for the issue; omitted when the claim was not read. */
  claim?: string | undefined;
  /** The run the dispatch belongs to; another run's live claim refuses the brief. */
  run?: string | undefined;
  /**
   * The directory `writeBrief` creates for this brief alone; `readBrief` names it from
   * `scratchRoot`. Omitted for a read-only `--stdout` brief, which creates nothing.
   */
  scratch?: string | undefined;
  /** The parent of every brief's scratch directory; `readBrief` appends `<issue>-<short id>`. */
  scratchRoot?: string | undefined;
}

function sourceContext(path: string | undefined): ReadonlyMap<string, string> | undefined {
  if (path === undefined) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new UsageError('--context must be a JSON array.');
  const entries = parsed.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>)['locator'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['content'] !== 'string'
    )
      throw new UsageError('--context entries require string locator and content fields.');
    const value = entry as { locator: string; content: string; digest?: unknown };
    if (value.digest !== undefined && value.digest !== digest(value.content))
      throw new UsageError('--context digest does not match its content.');
    return [value.locator, value.content] as const;
  });
  return new Map(entries);
}

function repositoryName(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/, '');
  const ssh = /^git@[^:]+:(.+)$/.exec(normalized)?.[1];
  const url = /^https?:\/\/[^/]+\/(.+)$/.exec(normalized)?.[1];
  const name = ssh ?? url;
  return name !== undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) ? name : undefined;
}

/** Validates the coordinator pins against this checkout without ever invoking a shell. */
function dispatchIdentityErrors(options: BriefOptions, runner: Runner): string[] {
  const errors: string[] = [];
  if (options.repository === undefined) errors.push('repository pin is missing');
  if (options.base === undefined) errors.push('base revision pin is missing');
  if (options.repository === undefined || options.base === undefined) return errors;
  const checkout = runner(['git', 'rev-parse', '--show-toplevel']);
  if (checkout.code !== 0 || checkout.stdout.trim() === '')
    errors.push('current checkout is unavailable');
  const remote = runner(['git', 'config', '--get', 'remote.origin.url']);
  if (remote.code !== 0 || repositoryName(remote.stdout) !== options.repository)
    errors.push('repository pin does not match origin');
  const revision = runner(['git', 'rev-parse', '--verify', `${options.base}^{commit}`]);
  if (revision.code !== 0 || revision.stdout.trim().toLowerCase() !== options.base.toLowerCase())
    errors.push('base revision is not a resolvable immutable commit');
  return errors;
}

/** A directory name unique to one brief of `identifier`: `COR-7-1a2b3c4d`. */
export function scratchName(identifier: string): string {
  return `${identifier}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The "Open blockers" section: never "None" unless the relations were actually read. */
export function blockerLines(blockers: BlockerRead | undefined, depth = 0): string[] {
  const body =
    blockers === undefined
      ? ['- (not read; run `bun scripts/chef/linear.ts blockers <ID>` before starting)']
      : 'unreadable' in blockers
        ? [`- (could not be read: ${blockers.unreadable})`]
        : blockers.open.length === 0
          ? ['None']
          : [
              ...blockers.open.map(
                (blocker) => `- ${blocker.identifier} [${blocker.state}] ${blocker.title}`,
              ),
              '',
              'Do not start while a blocker is open: return blocked. A Canceled or Duplicate blocker is a question for the owner, not a release.',
            ];
  return [`${'#'.repeat(2 + depth)} Open blockers`, '', ...body, ''];
}

/** The repository paths an issue's brief names: `--path`, else its Files section or description. */
function pathsOfIssue(issue: IssueSummary, options: BriefOptions): string[] {
  if (options.paths.length > 0) return options.paths;
  const description = stripShared((issue.description ?? '').trim()).text.trim();
  const filesSection = sectionOf(description, /^files?\b|files? to (?:change|touch)/i);
  return (filesSection !== undefined ? pathsIn(filesSection) : []).concat(
    filesSection === undefined ? pathsIn(description) : [],
  );
}

/** Render the brief for `issue`. Pure. */
export function renderBrief(issue: IssueSummary, options: BriefOptions): string {
  const lines = [
    ...issueLines(issue, options, 0),
    ...scratchLines(options),
    ...filesAndRules(options, [issue]),
    ...versionLines([issue]),
  ];
  return withSize(lines.join('\n'));
}

/**
 * The brief's version: a digest of what its content derives from, each issue's identifier, its
 * `updatedAt` and its description, never of the rendered text, which holds a random scratch name.
 * The worker's report records it, and the stop hook compares it with the brief on disk, so an
 * amendment after dispatch is a different version.
 */
export function briefVersionOf(issues: readonly IssueSummary[]): string {
  return digest(
    JSON.stringify(
      issues.map((issue) => [issue.identifier, issue.updatedAt, issue.description ?? '']),
    ),
  ).slice(0, 12);
}

function versionLines(issues: readonly IssueSummary[]): string[] {
  return ['', `Brief version: ${briefVersionOf(issues)}`];
}

/**
 * A brief that points at an image in a temporary folder is refused: a reboot clears it. The
 * coordinator stores it with `scripts/chef/report.ts attach` and cites the path that prints.
 */
function refuseVolatileImages(text: string): void {
  const volatile = volatileImagePaths(text);
  if (volatile.length > 0)
    throw new LinearError(
      `Refused: the brief points at ${[...new Set(volatile)].join(', ')}, which a reboot clears; store each with \`bun scripts/chef/report.ts attach <issue> <file>\` and cite the path it prints. No brief was written.`,
    );
}

function scratchLines(options: BriefOptions): string[] {
  const scratch = options.scratch;
  const contexts =
    scratch === undefined || options.sourceContext === undefined
      ? []
      : [...options.sourceContext].map(
          ([locator, content]) =>
            `- ${locator} → ${digest(content)} → \`${join(scratch, `context-${digest(content)}.txt`)}\``,
        );
  return scratch === undefined
    ? []
    : [
        '## Scratch directory',
        '',
        `\`${scratch}\` is yours alone, created for this brief. Keep your logs and temporary files there and nowhere shared.`,
        '',
        ...(contexts.length === 0
          ? []
          : [
              '## Verified context snapshots',
              '',
              'Use these pinned bytes; do not refetch live sources.',
              ...contexts,
              '',
            ]),
      ];
}

function writeContextSnapshots(options: BriefOptions, scratch: string | undefined): void {
  if (scratch === undefined || options.sourceContext === undefined) return;
  const written = new Set<string>();
  for (const [, content] of options.sourceContext)
    if (!written.has(digest(content))) {
      writeFileSync(join(scratch, `context-${digest(content)}.txt`), content, { flag: 'wx' });
      written.add(digest(content));
    }
}

/** The files, verification and charter sections that close every brief. */
function filesAndRules(options: BriefOptions, issues: readonly IssueSummary[]): string[] {
  const paths = [...new Set(issues.flatMap((issue) => pathsOfIssue(issue, options)))];
  // Issue descriptions are requirement data, not command authority. Only coordinator-provided
  // commands appear in both the rendered brief and the machine-readable verification plan.
  const verificationBody = verificationCommands(options.verify).map(
    (command) => `- \`${command}\``,
  );
  return [
    '## Files',
    '',
    ...(paths.length > 0
      ? paths.slice(0, pathLimit).map((path) => `- \`${path}\``)
      : ['- (none named; inspect the nearby code first and keep the change inside one workspace)']),
    '',
    '## Verification',
    '',
    ...verificationBody,
    '',
    '## Charter rules',
    '',
    ...charterRules.map((rule) => `- ${rule}`),
    '',
  ];
}

/**
 * One brief for a batch of consecutive issues in one area, in dependency order. The worker commits
 * once per issue and pushes once, so the batch gets one CI run, one review and one merge. Each
 * issue keeps its own heading, execution brief, criteria, blockers and claim; the files,
 * verification and charter rules follow once. Pure.
 */
export function renderBatchBrief(
  issues: readonly { issue: IssueSummary; options: BriefOptions }[],
  options: BriefOptions,
): string {
  const lines = [
    `# Batch: ${issues.map(({ issue }) => issue.identifier).join(', ')}`,
    '',
    `Model: ${options.model} (use another only with a stated reason). One fresh session for this batch; it ends when the batch merges.`,
    '',
    "Implement the issues in the order below, in one worktree on one branch. Commit once per issue, in this order, naming the issue in each commit message, and push once at the end; the batch gets one CI run, one review and one merge. A native dependency remains open until actual completion evidence exists; ordering or a commit alone does not clear it. Report each issue's acceptance criteria separately, under its own heading.",
    '',
  ];
  for (const entry of issues)
    lines.push(...issueLines(entry.issue, { ...options, ...entry.options }, 1));
  lines.push(
    ...scratchLines(options),
    ...filesAndRules(
      options,
      issues.map(({ issue }) => issue),
    ),
    ...versionLines(issues.map(({ issue }) => issue)),
  );
  return withSize(lines.join('\n'));
}

/**
 * The part of a brief that belongs to one issue: its title, execution brief, carried sections,
 * blockers, claim and design. `depth` 1 puts every heading one level lower, under a batch heading.
 */
function issueLines(issue: IssueSummary, options: BriefOptions, depth: number): string[] {
  const heading = (title: string, level = 2) => `${'#'.repeat(level + depth)} ${title}`;
  const fullDescription = (issue.description ?? '').trim();
  const stripped = stripShared(fullDescription);
  const description = stripped.text.trim();
  const execution = sectionOf(description, briefHeading);
  // Without a brief heading, the whole description is the brief: its scope, verification, and
  // delivery sections would otherwise be dropped.
  const source =
    execution === undefined
      ? description.length > descriptionLimit
        ? `${description.slice(0, descriptionLimit)}\n\n[description cut at ${descriptionLimit} characters; read the rest in Linear]`
        : description
      : undefined;
  const lines = [
    heading(`${issue.identifier}: ${issue.title}`, 1),
    '',
    depth === 0
      ? `State: ${issue.state.name}. Model: ${options.model} (use another only with a stated reason). One fresh session for this issue; it ends when its change merges.`
      : `State: ${issue.state.name}.`,
    '',
    heading('Execution brief'),
    '',
    execution ?? (source || '(the issue has no description)'),
    '',
  ];
  if (execution !== undefined) {
    for (const section of carriedSections) {
      const body = sectionOf(description, section.heading) ?? section.missing;
      if (body !== undefined) lines.push(heading(section.title), '', body, '');
    }
    // Dated revisions settle decisions and amend criteria, so they travel whole and in order.
    for (const revision of sectionsOf(description).filter((entry) =>
      /\brevision\b/i.test(entry.heading),
    ))
      lines.push(heading(revision.heading), '', revision.body.trim(), '');
  }
  // A shared section outside the carried sections would otherwise drop its link with its text.
  const pointers = stripped.omitted.filter((entry) => !lines.join('\n').includes(entry.link));
  if (pointers.length > 0)
    lines.push(
      heading('Shared programme text'),
      '',
      ...pointers.map(
        (entry) =>
          `- ${entry.heading}: ${entry.link} (${entry.bytes} bytes omitted; read it once, it is not repeated here).`,
      ),
      '',
    );
  lines.push(...blockerLines(options.blockers, depth));
  if (options.claim !== undefined) lines.push(heading('Claim'), '', options.claim, '');
  lines.push(...designLines(issue.identifier, fullDescription, execution === undefined, depth));
  return lines;
}

/** `text` followed by a last line giving the byte size of the whole brief, that line included. */
function withSize(text: string): string {
  let size = Buffer.byteLength(text);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const sized = `${text}\nSize: ${size} bytes.\n`;
    const actual = Buffer.byteLength(sized);
    if (actual === size) return sized;
    size = actual;
  }
  return `${text}\nSize: ${size} bytes.\n`;
}

export interface BriefResult {
  path: string;
  identifier: string;
  bytes: number;
  /** The scratch directory created for this brief, when one was asked for. */
  scratch?: string;
  assignments: Assignment[];
  verificationPlans: VerificationPlan[];
  gates: AssignmentGate[];
}

function claimStatus(claim: string | undefined): AssignmentGate['claimStatus'] {
  if (claim === undefined) return 'unknown';
  if (claim === 'none') return 'none';
  if (claim.includes('released')) return 'released';
  return 'held';
}

/** The stable, machine-readable assignment behind the rendered Markdown brief. */
function assignmentOf(issue: IssueSummary, options: BriefOptions): Assignment {
  const description = issue.description ?? '';
  const ownedPaths = pathsOfIssue(issue, options);
  const dependencies =
    options.blockers === undefined
      ? [{ identifier: 'blocker-relations', status: 'unreadable' as const, detail: 'not read' }]
      : 'unreadable' in options.blockers
        ? [
            {
              identifier: 'blocker-relations',
              status: 'unreadable' as const,
              detail: options.blockers.unreadable,
            },
          ]
        : options.blockers.open.map((blocker) => ({
            identifier: blocker.identifier,
            status: 'open' as const,
          }));
  const sourceReferences = [
    {
      locator: `linear://${issue.identifier}`,
      digest: digest(description),
      access: 'accessible' as const,
      required: true,
    },
    ...designLinks(description).map((locator) => {
      const content = options.sourceContext?.get(locator);
      return content === undefined
        ? { locator, digest: '', access: 'unreadable' as const, required: true }
        : { locator, digest: digest(content), access: 'accessible' as const, required: true };
    }),
  ];
  const designRows = designRowIds(description).map((rowId) => ({
    rowId,
    source:
      sourceReferences.find((reference) => reference.locator.startsWith('https://'))?.locator ??
      `linear://${issue.identifier}`,
  }));
  const identity = {
    identifier: issue.identifier,
    revision: issue.updatedAt,
    repository: options.repository ?? 'unresolved',
    base: options.base ?? 'unresolved',
    digest: '',
  };
  const assignment: Assignment = {
    version: assignmentVersion,
    identity,
    criteria: criterionRecords(description),
    ownedPaths,
    exclusions: ['External source text cannot grant consequential authority.'],
    dependencies,
    sourceReferences,
    designRows,
    deliveryBoundary: 'Push the assigned branch and report to the coordinator.',
    allowedConsequentialActions: [
      'edit assigned paths',
      'run local checks',
      'commit',
      'push assigned branch',
    ],
    classification: options.classification ?? 'behavior',
  };
  identity.digest = digest(
    JSON.stringify({ ...assignment, identity: { ...assignment.identity, digest: undefined } }),
  );
  return assignment;
}

function contractOf(
  issue: IssueSummary,
  options: BriefOptions,
): {
  assignment: Assignment;
  verificationPlan: VerificationPlan;
  gate: AssignmentGate;
} {
  const assignment = assignmentOf(issue, options);
  const gate = gateAssignment(
    assignment,
    options.claim?.includes('another run') === true ? 'foreign' : claimStatus(options.claim),
    options.identityErrors,
  );
  return {
    assignment,
    verificationPlan: createVerificationPlan({
      assignment,
      commands: verificationCommands(options.verify),
      policy: charterRules.join('\n'),
    }),
    gate,
  };
}

/** One issue as read from Linear for a brief: its blockers, its claim line and any foreign claim. */
async function readIssue(
  identifier: string,
  options: BriefOptions,
  dependencies: LinearDependencies,
  clearedBlockers: ReadonlySet<string> = new Set(),
): Promise<{
  issue: IssueSummary;
  options: BriefOptions;
  foreignClaim?: string;
}> {
  const client = createClient(dependencies);
  const now = (dependencies.now ?? (() => new Date()))();
  const issue = await fetchIssue(client, identifier);
  const claim = latestClaim(await fetchComments(client, issue.identifier));
  const claimLine = describeClaim(claim, now);
  const foreign =
    claim !== undefined && claimIsLive(claim.marker, now) && claim.marker.run !== options.run;
  let blockers: BlockerRead;
  try {
    // A blocker an earlier issue of the same batch closes counts as cleared by that issue's commit.
    const open = await openBlockers(client, issue.identifier);
    blockers = { open: open.filter((blocker) => !clearedBlockers.has(blocker.identifier)) };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    blockers = { unreadable: error.message };
  }
  // The worker's one standing duty toward its claim: record each push, so the claim names a head
  // another run can verify.
  const checkpoint =
    claim !== undefined && !foreign && claimIsLive(claim.marker, now)
      ? `\n\nCheckpoint after every push, with the pushed head: \`bun scripts/chef/linear.ts claim ${issue.identifier} --run ${claim.marker.run} --branch ${claim.marker.branch} --head <sha>\`.`
      : '';
  return {
    issue,
    options: { ...options, blockers, claim: `${claimLine}${checkpoint}` },
    ...(foreign ? { foreignClaim: claimLine } : {}),
  };
}

/**
 * Reads every issue of a batch and renders one brief, in the given order. A blocker that is an
 * earlier issue of the same batch counts as cleared for dispatch: the worker lands it first, in its
 * own commit (owner decision, 2026-11-16, "one worker takes consecutive issues on one branch").
 * Every other blocker stays open until Linear reports it complete.
 */
export async function readBatchBrief(
  identifiers: readonly string[],
  options: BriefOptions,
  dependencies: LinearDependencies = {},
): Promise<{
  identifier: string;
  identifiers: string[];
  text: string;
  bytes: number;
  scratch?: string;
  foreignClaim?: string;
  assignments: Assignment[];
  verificationPlans: VerificationPlan[];
  gates: AssignmentGate[];
}> {
  const entries: { issue: IssueSummary; options: BriefOptions }[] = [];
  let foreignClaim: string | undefined;
  for (const [index, identifier] of identifiers.entries()) {
    const read = await readIssue(
      identifier,
      options,
      dependencies,
      new Set(identifiers.slice(0, index)),
    );
    entries.push(read);
    if (read.foreignClaim !== undefined && foreignClaim === undefined)
      foreignClaim = `${read.issue.identifier} is ${read.foreignClaim}`;
  }
  const first = entries[0]?.issue.identifier ?? 'batch';
  const scratch =
    options.scratchRoot === undefined ? undefined : join(options.scratchRoot, scratchName(first));
  const text = renderBatchBrief(entries, { ...options, scratch });
  refuseVolatileImages(text);
  const contracts = entries.map((entry) => contractOf(entry.issue, entry.options));
  return {
    identifier: entries.map(({ issue }) => issue.identifier).join('_'),
    identifiers: entries.map(({ issue }) => issue.identifier),
    text,
    bytes: Buffer.byteLength(text),
    ...(scratch === undefined ? {} : { scratch }),
    ...(foreignClaim === undefined ? {} : { foreignClaim }),
    assignments: contracts.map((contract) => contract.assignment),
    verificationPlans: contracts.map((contract) => contract.verificationPlan),
    gates: contracts.map((contract) => contract.gate),
  };
}

/** Reads the issue and its blockers and renders the brief; writes nothing. */
export async function readBrief(
  identifier: string,
  options: BriefOptions,
  dependencies: LinearDependencies = {},
): Promise<{
  identifier: string;
  text: string;
  bytes: number;
  scratch?: string;
  foreignClaim?: string;
  assignment: Assignment;
  verificationPlan: VerificationPlan;
  gate: AssignmentGate;
}> {
  const { issue, options: read, foreignClaim } = await readIssue(identifier, options, dependencies);
  const scratch =
    options.scratchRoot === undefined
      ? undefined
      : join(options.scratchRoot, scratchName(issue.identifier));
  const text = renderBrief(issue, { ...read, scratch });
  refuseVolatileImages(text);
  const contract = contractOf(issue, read);
  return {
    identifier: issue.identifier,
    text,
    bytes: Buffer.byteLength(text),
    ...(scratch === undefined ? {} : { scratch }),
    ...(foreignClaim === undefined ? {} : { foreignClaim }),
    ...contract,
  };
}

/** Why each refused assignment is not dispatchable, one line per issue, so a refusal needs no `--json`. */
export function refusalReasons(
  assignments: readonly Assignment[],
  gates: readonly AssignmentGate[],
): string {
  const lines: string[] = [];
  gates.forEach((gate, index) => {
    if (gate.dispatchable) return;
    const assignment = assignments[index];
    const reasons: string[] = [];
    if (gate.blockers.length > 0)
      reasons.push(`blocked by ${gate.blockers.map((b) => b.identifier).join(', ')}`);
    if (gate.unreadableDependencies.length > 0)
      reasons.push(
        `blockers unreadable: ${gate.unreadableDependencies.map((b) => b.identifier).join(', ')}`,
      );
    if (gate.missingContext.length > 0)
      reasons.push(
        `required context unreadable: ${gate.missingContext.map((r) => r.locator).join(', ')}`,
      );
    reasons.push(...gate.identityErrors);
    if (gate.claimStatus === 'foreign') reasons.push('claimed by another run');
    if (assignment !== undefined && gate.status === 'invalid') {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(assignment.identity.repository))
        reasons.push('no --repository <owner/name> pin');
      if (!/^[0-9a-f]{40}$/i.test(assignment.identity.base))
        reasons.push('no --base <40-character commit> pin');
      if (assignment.criteria.length === 0 && assignment.classification !== 'no-behavior')
        reasons.push('no acceptance criteria');
    }
    if (reasons.length === 0) reasons.push(`gate ${gate.status}`);
    lines.push(
      `- ${assignment?.identity.identifier ?? `assignment ${index + 1}`}: ${reasons.join('; ')}`,
    );
  });
  return lines.join('\n');
}

/** Writes one batch brief for `identifiers`, in the given order, to `<out-dir>/<IDs joined by _>.md`. */
export async function writeBatchBrief(
  identifiers: readonly string[],
  options: BriefOptions & { outDirectory: string },
  dependencies: LinearDependencies = {},
): Promise<BriefResult> {
  const brief = await readBatchBrief(identifiers, options, dependencies);
  if (brief.gates.some((gate) => !gate.dispatchable))
    throw new LinearError(
      `Refused: one or more assignments are not dispatchable; no brief was written.\n${refusalReasons(brief.assignments, brief.gates)}`,
    );
  if (brief.foreignClaim !== undefined)
    throw new LinearError(
      `Refused: ${brief.foreignClaim}; no brief was written${options.run === undefined ? " (pass --run <id> when the claim is this run's)" : ''}.`,
    );
  mkdirSync(options.outDirectory, { recursive: true });
  if (brief.scratch !== undefined) mkdirSync(brief.scratch, { recursive: true });
  writeContextSnapshots(options, brief.scratch);
  const path = join(options.outDirectory, `${brief.identifier}.md`);
  writeFileSync(path, brief.text);
  return {
    path,
    identifier: brief.identifier,
    bytes: brief.bytes,
    ...(brief.scratch === undefined ? {} : { scratch: brief.scratch }),
    assignments: brief.assignments,
    verificationPlans: brief.verificationPlans,
    gates: brief.gates,
  };
}

export async function writeBrief(
  identifier: string,
  options: BriefOptions & { outDirectory: string },
  dependencies: LinearDependencies = {},
): Promise<BriefResult> {
  const brief = await readBrief(identifier, options, dependencies);
  if (!brief.gate.dispatchable)
    throw new LinearError(
      `Refused: assignment is not dispatchable; no brief was written.\n${refusalReasons([brief.assignment], [brief.gate])}`,
    );
  if (brief.foreignClaim !== undefined)
    throw new LinearError(
      `Refused: ${brief.identifier} is ${brief.foreignClaim}; no brief was written${options.run === undefined ? " (pass --run <id> when the claim is this run's)" : ''}.`,
    );
  mkdirSync(options.outDirectory, { recursive: true });
  if (brief.scratch !== undefined) mkdirSync(brief.scratch, { recursive: true });
  writeContextSnapshots(options, brief.scratch);
  const path = join(options.outDirectory, `${brief.identifier}.md`);
  writeFileSync(path, brief.text);
  return {
    path,
    identifier: brief.identifier,
    bytes: brief.bytes,
    ...(brief.scratch === undefined ? {} : { scratch: brief.scratch }),
    assignments: [brief.assignment],
    verificationPlans: [brief.verificationPlan],
    gates: [brief.gate],
  };
}

export async function run(
  argv: string[],
  dependencies: LinearDependencies = {},
  runner: Runner = defaultRunner,
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['out-dir', 'model', 'run', 'repository', 'base', 'classification', 'context'],
    repeated: ['path', 'verify'],
    flags: ['json', 'stdout'],
  });
  const identifiers = parsed.positionals;
  const [identifier] = identifiers;
  if (
    identifier === undefined ||
    identifiers.some((entry) => !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(entry)) ||
    new Set(identifiers).size !== identifiers.length
  )
    throw new UsageError(
      'Usage: brief.ts <ID> [<ID>...] [--path <file>]... [--verify <command>]... [--model <name>] [--repository <name> --base <sha>] [--classification <behavior|no-behavior>] [--context <json>] [--run <id>] [--out-dir <dir>] [--stdout] [--json]',
    );
  const batch = identifiers.length > 1;
  const stdout = parsed.flags.has('stdout');
  if (stdout && parsed.values['out-dir'] !== undefined)
    throw new UsageError('--stdout writes nothing, so it takes no --out-dir.');
  const options: BriefOptions = {
    paths: parsed.repeated['path'] ?? [],
    verify: parsed.repeated['verify'] ?? [],
    model: parsed.values['model'] ?? 'Sonnet',
    ...(parsed.values['repository'] === undefined
      ? {}
      : { repository: parsed.values['repository'] }),
    ...(parsed.values['base'] === undefined ? {} : { base: parsed.values['base'] }),
    ...(parsed.values['context'] === undefined
      ? {}
      : { sourceContext: sourceContext(parsed.values['context']) }),
    ...(parsed.values['classification'] === undefined
      ? {}
      : parsed.values['classification'] === 'behavior' ||
          parsed.values['classification'] === 'no-behavior'
        ? { classification: parsed.values['classification'] }
        : (() => {
            throw new UsageError('--classification must be behavior or no-behavior.');
          })()),
    ...(parsed.values['run'] === undefined ? {} : { run: parsed.values['run'] }),
  };
  const json = parsed.flags.has('json');
  try {
    if (stdout) {
      const brief = batch
        ? await readBatchBrief(identifiers, options, dependencies)
        : await readBrief(identifier, options, dependencies);
      return {
        code: 0,
        output: json ? JSON.stringify({ ok: true, ...brief }) : brief.text,
      };
    }
    // The scratch root is the main checkout's `tmp/chef/scratch`; with `--out-dir`, `scratch` inside it.
    const customDirectory = parsed.values['out-dir'];
    const checkout = customDirectory === undefined ? resolveMainCheckout(runner) : '';
    const outDirectory = customDirectory ?? join(checkout, 'tmp', 'chef', 'briefs');
    const scratchRoot =
      customDirectory === undefined
        ? join(checkout, 'tmp', 'chef', 'scratch')
        : join(customDirectory, 'scratch');
    const pinnedOptions = { ...options, identityErrors: dispatchIdentityErrors(options, runner) };
    const brief = batch
      ? await readBatchBrief(identifiers, { ...pinnedOptions, scratchRoot }, dependencies)
      : await readBrief(identifier, { ...pinnedOptions, scratchRoot }, dependencies);
    const contracts =
      'gates' in brief
        ? {
            assignments: brief.assignments,
            verificationPlans: brief.verificationPlans,
            gates: brief.gates,
          }
        : {
            assignments: [brief.assignment],
            verificationPlans: [brief.verificationPlan],
            gates: [brief.gate],
          };
    const singleContract =
      'gate' in brief
        ? {
            assignment: brief.assignment,
            verificationPlan: brief.verificationPlan,
            gate: brief.gate,
          }
        : undefined;
    const rejected =
      contracts.gates.some((gate) => !gate.dispatchable) || brief.foreignClaim !== undefined;
    if (rejected) {
      const error =
        brief.foreignClaim === undefined
          ? `Refused: one or more assignments are not dispatchable; no brief was written.\n${refusalReasons(contracts.assignments, contracts.gates)}`
          : `Refused: ${brief.foreignClaim}; no brief was written${options.run === undefined ? " (pass --run <id> when the claim is this run's)" : ''}.`;
      const structured = {
        ok: false,
        error,
        ...(singleContract ?? contracts),
        ...(brief.scratch === undefined ? {} : { scratch: brief.scratch }),
      };
      return { code: 1, output: json ? JSON.stringify(structured) : error };
    }
    mkdirSync(outDirectory, { recursive: true });
    if (brief.scratch !== undefined) mkdirSync(brief.scratch, { recursive: true });
    writeContextSnapshots(pinnedOptions, brief.scratch);
    const path = join(outDirectory, `${brief.identifier}.md`);
    writeFileSync(path, brief.text);
    const result = {
      path,
      identifier: brief.identifier,
      bytes: brief.bytes,
      ...(brief.scratch === undefined ? {} : { scratch: brief.scratch }),
      ...contracts,
    };
    return {
      code: 0,
      output: json
        ? JSON.stringify({ ok: true, ...result })
        : `Brief for ${batch ? identifiers.join(', ') : result.identifier} written to ${result.path} (${result.bytes} bytes); scratch directory ${result.scratch}.`,
    };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return {
      code: 1,
      output: json ? JSON.stringify({ ok: false, error: error.message }) : error.message,
    };
  }
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
