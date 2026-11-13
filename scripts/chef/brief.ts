#!/usr/bin/env bun
// Chef brief: turns one Linear issue into a compact brief file, so the coordinator starts one fresh
// session per issue from a short, self-contained document instead of a long-lived session that
// carries a stream's whole history. On the 2026-10-22 run, long-lived stream sessions averaged
// about 470K tokens of context per call, and about 88% of the spend was re-reading it.
//
// Usage:
//   bun scripts/chef/brief.ts <ID> [--path <file>]... [--verify <command>]... [--model <name>]
//                             [--run <id>] [--out-dir <dir>] [--stdout] [--json]
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
//   - the verification commands: each `--verify`, else the issue's Verification section, else the
//     focused checks for what the worker changed, with the root lint always among them;
//   - the charter rules every worker gets (`charterRules` below, their one source; the
//     `references/execution-record.md` "Worker charter" template points here): cost, checks,
//     branch updates, delivery, the review rounds, the turn rule, the defect-class self-check,
//     context, the report, corrections, and acceptance-criteria statuses.
//
// The script only prepares the brief. The coordinator tool starts the session: one fresh session
// per issue, on Sonnet unless the brief names a reason for another model, from this file, and the
// session ends when its change merges (by pull request or by a direct merge of its pushed branch).
// Never reuse a session for the next issue.
//
// Exit codes: 0 brief written, 1 issue not found or API failure, 2 invalid CLI usage.

import { mkdirSync, writeFileSync } from 'node:fs';
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
import { resolveMainCheckout } from './repository-locations.ts';

export { UsageError };

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
  '**Checks:** run the focused checks on what you changed once, when the change is complete, in the background and never polled, not `bun run check`: `bun scripts/chef/focused-checks.ts`; fix every failed step. A test file that starts a process is named `*.integration.test.ts`; the command runs `bun scripts/affected-tests.ts run --isolated` when your change reaches one. The full suite only for a one-way door, the lock or concurrency infrastructure, or `turbo.json` and the root scripts, and then on GitHub with `gh workflow run main.yml --ref <branch>`, never a local `bun run validate`. Delivery runs no gate.',
  '**Branch:** update from `main` only by a real merge (`git fetch origin main && git merge FETCH_HEAD`), never `git reset --soft` onto a newer `main`. Before every push, run `bun scripts/chef/revert-check.ts` and read `git diff --name-only origin/main...HEAD`; a file you did not mean to change means a stale tree.',
  `**Delivery:** ${deliveryRule}`,
  '**Review rounds, with a pull request open (AGENTS.md "Review guidelines"):** answer every thread before merge; at most three rounds; round one fixes every real finding; rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; then open items go to one follow-up issue; push once per round, because Codex reviews every push automatically; do not re-answer a re-reported comment.',
  '**Turn rule:** end a turn only on a state change: merged, blocked, needs-decision, or ready-for-review. Wait on a completion; never poll, and never end a turn to say you are still waiting.',
  '**Defect-class self-check:** before pushing, check the diff against every class in `.agents/skills/chef/references/defect-classes.md` and report each. With a pull request open, run `bun scripts/chef/review-threads.ts classes --pr <n>` before every fix push; on exit 1, push nothing more and return blocked.',
  '**Context:** there is no context ceiling; work until the change is complete and verified. Keep context small anyway: write long output to a file and read its tail.',
  '**Report:** your final message is the report, at most 15 lines; do not create a `report.md` or any other report file. Lines: `status:`, `pr:` (or none), `head:`, `worktree:`, `checks:` (command and exit code), `revert check:`, `changed files:`, `not verified:`, `decisions:`, and each acceptance criterion with its status. Logs and evidence go under `tmp/chef/<package>/round-<n>/` in the main checkout. Your final step runs `bun scripts/chef/leftovers.ts` and quotes its line.',
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

function designLines(identifier: string, description: string, descriptionIncluded: boolean) {
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
    '## Design',
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
    '- Before the pull request is ready, capture the screens you changed (`bun scripts/design-review-capture.ts` in `applications/interborough`) and get an implementation review from the `design-reviewer` agent, following the `design-review` skill: write these rows as its rows file (`row-id | board | requirement text`, where `board` is the file stem you saved under `boards/`, the name without `.dc.html`), and check its `row-verdicts.txt` with `bun scripts/design-review-rows.ts` in `applications/interborough`. Put the verdict lines (`row-id | verdict | evidence`) in the pull request body and your report. Only `matches`, or `deferred` with the reason recorded on the issue, passes; `drifted`, `partial`, `missing` and `unverified` block the pull request.',
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
  /** Omitted when the blockers were not read; the brief then says so instead of "None". */
  blockers?: BlockerRead | undefined;
  /** `describeClaim`'s line for the issue; omitted when the claim was not read. */
  claim?: string | undefined;
  /** The run the dispatch belongs to; another run's live claim refuses the brief. */
  run?: string | undefined;
}

/** The "Open blockers" section: never "None" unless the relations were actually read. */
export function blockerLines(blockers: BlockerRead | undefined): string[] {
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
  return ['## Open blockers', '', ...body, ''];
}

/** Render the brief for `issue`. Pure. */
export function renderBrief(issue: IssueSummary, options: BriefOptions): string {
  const fullDescription = (issue.description ?? '').trim();
  const stripped = stripShared(fullDescription);
  const description = stripped.text.trim();
  const execution = sectionOf(description, briefHeading);
  const filesSection = sectionOf(description, /^files?\b|files? to (?:change|touch)/i);
  const paths =
    options.paths.length > 0
      ? options.paths
      : (filesSection !== undefined ? pathsIn(filesSection) : []).concat(
          filesSection === undefined ? pathsIn(description) : [],
        );
  // Without a brief heading, the whole description is the brief: its scope, verification, and
  // delivery sections would otherwise be dropped.
  const source =
    execution === undefined
      ? description.length > descriptionLimit
        ? `${description.slice(0, descriptionLimit)}\n\n[description cut at ${descriptionLimit} characters; read the rest in Linear]`
        : description
      : undefined;
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `State: ${issue.state.name}. Model: ${options.model} (use another only with a stated reason). One fresh session for this issue; it ends when its change merges.`,
    '',
    '## Execution brief',
    '',
    execution ?? (source || '(the issue has no description)'),
    '',
  ];
  if (execution !== undefined) {
    for (const section of carriedSections) {
      const body = sectionOf(description, section.heading) ?? section.missing;
      if (body !== undefined) lines.push(`## ${section.title}`, '', body, '');
    }
    // Dated revisions settle decisions and amend criteria, so they travel whole and in order.
    for (const revision of sectionsOf(description).filter((entry) =>
      /\brevision\b/i.test(entry.heading),
    ))
      lines.push(`## ${revision.heading}`, '', revision.body.trim(), '');
  }
  // A shared section outside the carried sections would otherwise drop its link with its text.
  const pointers = stripped.omitted.filter((entry) => !lines.join('\n').includes(entry.link));
  if (pointers.length > 0)
    lines.push(
      '## Shared programme text',
      '',
      ...pointers.map(
        (entry) =>
          `- ${entry.heading}: ${entry.link} (${entry.bytes} bytes omitted; read it once, it is not repeated here).`,
      ),
      '',
    );
  lines.push(...blockerLines(options.blockers));
  if (options.claim !== undefined) lines.push('## Claim', '', options.claim, '');
  lines.push(...designLines(issue.identifier, fullDescription, execution === undefined));
  lines.push('## Files', '');
  const issueVerification =
    execution !== undefined && options.verify.length === 0
      ? sectionOf(description, /^verification\b/i)
      : undefined;
  lines.push(
    ...(paths.length > 0
      ? paths.slice(0, pathLimit).map((path) => `- \`${path}\``)
      : ['- (none named; inspect the nearby code first and keep the change inside one workspace)']),
    '',
    '## Verification',
    '',
    ...(issueVerification === undefined
      ? verificationCommands(options.verify).map((command) => `- \`${command}\``)
      : runsRootLint(issueVerification)
        ? [issueVerification]
        : [issueVerification, `- \`${rootLint}\``]),
    '',
    '## Charter rules',
    '',
    ...charterRules.map((rule) => `- ${rule}`),
    '',
  );
  return withSize(lines.join('\n'));
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
}

/** Reads the issue and its blockers and renders the brief; writes nothing. */
export async function readBrief(
  identifier: string,
  options: BriefOptions,
  dependencies: LinearDependencies = {},
): Promise<{ identifier: string; text: string; bytes: number; foreignClaim?: string }> {
  const client = createClient(dependencies);
  const now = (dependencies.now ?? (() => new Date()))();
  const issue = await fetchIssue(client, identifier);
  const claim = latestClaim(await fetchComments(client, issue.identifier));
  const claimLine = describeClaim(claim, now);
  const foreign =
    claim !== undefined && claimIsLive(claim.marker, now) && claim.marker.run !== options.run;
  let blockers: BlockerRead;
  try {
    blockers = { open: await openBlockers(client, issue.identifier) };
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
  const text = renderBrief(issue, { ...options, blockers, claim: `${claimLine}${checkpoint}` });
  return {
    identifier: issue.identifier,
    text,
    bytes: Buffer.byteLength(text),
    ...(foreign ? { foreignClaim: claimLine } : {}),
  };
}

export async function writeBrief(
  identifier: string,
  options: BriefOptions & { outDirectory: string },
  dependencies: LinearDependencies = {},
): Promise<BriefResult> {
  const brief = await readBrief(identifier, options, dependencies);
  if (brief.foreignClaim !== undefined)
    throw new LinearError(
      `Refused: ${brief.identifier} is ${brief.foreignClaim}; no brief was written${options.run === undefined ? " (pass --run <id> when the claim is this run's)" : ''}.`,
    );
  mkdirSync(options.outDirectory, { recursive: true });
  const path = join(options.outDirectory, `${brief.identifier}.md`);
  writeFileSync(path, brief.text);
  return { path, identifier: brief.identifier, bytes: brief.bytes };
}

export async function run(
  argv: string[],
  dependencies: LinearDependencies = {},
  runner: Runner = defaultRunner,
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['out-dir', 'model', 'run'],
    repeated: ['path', 'verify'],
    flags: ['json', 'stdout'],
  });
  const [identifier, ...extra] = parsed.positionals;
  if (
    identifier === undefined ||
    extra.length > 0 ||
    !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)
  )
    throw new UsageError(
      'Usage: brief.ts <ID> [--path <file>]... [--verify <command>]... [--model <name>] [--run <id>] [--out-dir <dir>] [--stdout] [--json]',
    );
  const stdout = parsed.flags.has('stdout');
  if (stdout && parsed.values['out-dir'] !== undefined)
    throw new UsageError('--stdout writes nothing, so it takes no --out-dir.');
  const options: BriefOptions = {
    paths: parsed.repeated['path'] ?? [],
    verify: parsed.repeated['verify'] ?? [],
    model: parsed.values['model'] ?? 'Sonnet',
    ...(parsed.values['run'] === undefined ? {} : { run: parsed.values['run'] }),
  };
  const json = parsed.flags.has('json');
  try {
    if (stdout) {
      const brief = await readBrief(identifier, options, dependencies);
      return {
        code: 0,
        output: json ? JSON.stringify({ ok: true, ...brief }) : brief.text,
      };
    }
    const outDirectory =
      parsed.values['out-dir'] ?? join(resolveMainCheckout(runner), 'tmp', 'chef', 'briefs');
    const result = await writeBrief(identifier, { ...options, outDirectory }, dependencies);
    return {
      code: 0,
      output: json
        ? JSON.stringify({ ok: true, ...result })
        : `Brief for ${result.identifier} written to ${result.path} (${result.bytes} bytes).`,
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
