#!/usr/bin/env bun
// Chef brief: turns one Linear issue into a compact brief file, so the coordinator starts one fresh
// session per issue from a short, self-contained document instead of a long-lived session that
// carries a stream's whole history. On the 2026-10-22 run, long-lived stream sessions averaged
// about 470K tokens of context per call, and about 88% of the spend was re-reading it.
//
// Usage:
//   bun scripts/chef/brief.ts <ID> [--path <file>]... [--verify <command>]... [--model <name>]
//                             [--out-dir <dir>] [--json]
//
// It reads the issue with `linear.ts`'s client and writes `<main checkout>/tmp/chef/briefs/<ID>.md`
// (gitignored; `--out-dir` replaces the directory) holding:
//   - the issue's execution brief and acceptance criteria: the description sections under those
//     headings, or the whole description when it has neither;
//   - when the issue names a design (a claude.ai artifact link or a "Design source" section): the
//     design rows, the rows its acceptance criteria leave out, and the instruction to build against
//     the saved boards and return a design-review verdict per row;
//   - the files: each `--path`, else the "Files" section, else the path-like code spans in the
//     description;
//   - the verification commands: each `--verify`, else the focused checks for what the worker changed;
//   - the charter rules every worker gets (`references/execution-record.md` "Worker charter"): the
//     merge gate, the review rounds, the turn rule, and the defect-class self-check.
//
// The script only prepares the brief. The coordinator tool starts the session: one fresh session
// per issue, on Sonnet unless the brief names a reason for another model, from this file, and the
// session ends when its pull request merges. Never reuse a session for the next issue.
//
// Exit codes: 0 brief written, 1 issue not found or API failure, 2 invalid CLI usage.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createClient,
  fetchIssue,
  type IssueSummary,
  type LinearDependencies,
  LinearError,
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

/** The charter rules, kept equal to `references/execution-record.md` by `brief.test.ts`. */
export const charterRules = [
  '**Merge gate:** run the focused checks on what you changed before opening the pull request, not `bun run check`: `bun test` on the touched files, `bun run lint:root` always, because its guards scan the tests of every workspace, `bun run typecheck:root` when root or `scripts/` files changed, `bunx turbo run lint typecheck --filter=<workspace>` for each changed workspace, and `bunx prettier --check` on the changed files. A full `bun run validate` only for a one-way door, the lock or concurrency infrastructure, or `turbo.json` and the root scripts. Delivery runs no gate and does not repeat a check because `main` moved. You do not merge: after the coordinator accepts your ready-for-review return, it delivers with `deliver.ts`, which refuses for a conflict with the base, an unresolved review thread, or a head other than the one accepted. On a conflict, merge `main` in yourself, run the focused checks again, and return the new head. A red `main` is a warning there, not a refusal.',
  '**Review rounds (AGENTS.md "Review guidelines"):** answer every thread before merge; at most three rounds; round one fixes every real finding; rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; after round three, open items go to one follow-up issue; push once per round, because Codex reviews every push automatically; do not re-answer a re-reported comment.',
  '**Turn rule:** end a turn only on a state change: merged, blocked, needs-decision, or ready-for-review. Wait for a gate, a check, or a review bot in a background command and keep working; never end a turn to report that you are still waiting.',
  "**Defect-class self-check:** before opening the pull request, check the diff against every class in `.agents/skills/chef/references/defect-classes.md`, fix what applies, and report each class's result in the return. Before every fix push, run `bun scripts/chef/review-threads.ts classes --pr <n>`; on exit 1, push no further patch and return blocked.",
  '**Context:** keep it small. Write gate output to a log and read a failure with a targeted search. A context past about 250K tokens means: write a handoff brief under `tmp/chef/` and hand off to a fresh session.',
  '**Report:** your final message is the report, at most 15 lines; do not create a `report.md` or any other report file. Write logs and evidence under `tmp/chef/<package>/round-<n>/` in the main checkout, with a new directory for each correction round. Your final step runs `bun scripts/chef/leftovers.ts` and quotes its line.',
  '**Corrections:** after two unsuccessful attempts at the same defect, stop patching and return evidence for causal reassessment.',
];

const rootLint = 'bun run lint:root';

const defaultVerification = [
  'bun test <the test files you changed>',
  rootLint,
  'bun run typecheck:root',
  'bunx prettier --check <the files you changed>',
];

/**
 * The verification list: the explicit commands, or the defaults when there are none. The
 * root lint is always on it, because its guards scan the tests of every workspace, so a
 * change inside one workspace can fail it.
 */
export function verificationCommands(explicit: string[]): string[] {
  if (explicit.length === 0) return defaultVerification;
  return explicit.includes(rootLint) ? explicit : [...explicit, rootLint];
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
const pathLimit = 40;

export interface BriefOptions {
  paths: string[];
  verify: string[];
  model: string;
}

/** Render the brief for `issue`. Pure. */
export function renderBrief(issue: IssueSummary, options: BriefOptions): string {
  const description = (issue.description ?? '').trim();
  const execution = sectionOf(description, /execution\s+brief/i);
  const criteria = sectionOf(description, /acceptance\s+criteria/i);
  const filesSection = sectionOf(description, /^files?\b|files? to (?:change|touch)/i);
  const paths =
    options.paths.length > 0
      ? options.paths
      : (filesSection !== undefined ? pathsIn(filesSection) : []).concat(
          filesSection === undefined ? pathsIn(description) : [],
        );
  // Without an execution-brief heading, the whole description is the brief: its scope,
  // verification, and delivery sections would otherwise be dropped.
  const source =
    execution === undefined
      ? description.length > descriptionLimit
        ? `${description.slice(0, descriptionLimit)}\n\n[description cut at ${descriptionLimit} characters; read the rest in Linear]`
        : description
      : undefined;
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `State: ${issue.state.name}. Model: ${options.model} (use another only with a stated reason). One fresh session for this issue; it ends when its pull request merges.`,
    '',
    '## Execution brief',
    '',
    execution ?? (source || '(the issue has no description)'),
    '',
  ];
  if (execution !== undefined) {
    lines.push(
      '## Acceptance criteria',
      '',
      criteria ?? '(none stated; derive them from the execution brief and write them down first)',
      '',
    );
  }
  lines.push(...designLines(issue.identifier, description, execution === undefined));
  lines.push('## Files', '');
  lines.push(
    ...(paths.length > 0
      ? paths.slice(0, pathLimit).map((path) => `- \`${path}\``)
      : ['- (none named; inspect the nearby code first and keep the change inside one workspace)']),
    '',
    '## Verification',
    '',
    ...verificationCommands(options.verify).map((command) => `- \`${command}\``),
    '',
    '## Charter rules',
    '',
    ...charterRules.map((rule) => `- ${rule}`),
    '',
  );
  return lines.join('\n');
}

export interface BriefResult {
  path: string;
  identifier: string;
  bytes: number;
}

export async function writeBrief(
  identifier: string,
  options: BriefOptions & { outDirectory: string },
  dependencies: LinearDependencies = {},
): Promise<BriefResult> {
  const issue = await fetchIssue(createClient(dependencies), identifier);
  const text = renderBrief(issue, options);
  mkdirSync(options.outDirectory, { recursive: true });
  const path = join(options.outDirectory, `${issue.identifier}.md`);
  writeFileSync(path, text);
  return { path, identifier: issue.identifier, bytes: Buffer.byteLength(text) };
}

export async function run(
  argv: string[],
  dependencies: LinearDependencies = {},
  runner: Runner = defaultRunner,
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['out-dir', 'model'],
    repeated: ['path', 'verify'],
    flags: ['json'],
  });
  const [identifier, ...extra] = parsed.positionals;
  if (
    identifier === undefined ||
    extra.length > 0 ||
    !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier)
  )
    throw new UsageError(
      'Usage: brief.ts <ID> [--path <file>]... [--verify <command>]... [--model <name>] [--out-dir <dir>] [--json]',
    );
  const outDirectory =
    parsed.values['out-dir'] ?? join(resolveMainCheckout(runner), 'tmp', 'chef', 'briefs');
  try {
    const result = await writeBrief(
      identifier,
      {
        paths: parsed.repeated['path'] ?? [],
        verify: parsed.repeated['verify'] ?? [],
        model: parsed.values['model'] ?? 'Sonnet',
        outDirectory,
      },
      dependencies,
    );
    return {
      code: 0,
      output: parsed.flags.has('json')
        ? JSON.stringify({ ok: true, ...result })
        : `Brief for ${result.identifier} written to ${result.path} (${result.bytes} bytes).`,
    };
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    return {
      code: 1,
      output: parsed.flags.has('json')
        ? JSON.stringify({ ok: false, error: error.message })
        : error.message,
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
