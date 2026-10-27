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
//   - the files: each `--path`, else the "Files" section, else the path-like code spans in the
//     description;
//   - the verification commands: each `--verify`, else `bun run check` and the focused test line;
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
  '**Merge gate:** `bun run check` per pull request, run shared and launched with `bun scripts/chef/gate-run.ts run`; a full `bun run validate` only for a one-way door, the lock or concurrency infrastructure, or `turbo.json` and the root scripts. Merge only with `bun scripts/chef/merge-gate.ts`, after the coordinator has accepted your ready-for-review return. Never merge into a red `main` unless the pull request is its fix (`--fixes-main`) or the coordinator waives a load flake (`--waive-load-flake <reason> --control-head <sha>`).',
  '**Review rounds (AGENTS.md "Review guidelines"):** answer every thread before merge; at most three rounds; round one fixes every real finding; rounds two and three fix only regressions, one-way-door defects, and real defects in changed lines; after round three, open items go to one follow-up issue; push once per round, because Codex reviews every push automatically; do not re-answer a re-reported comment.',
  '**Turn rule:** end a turn only on a state change: merged, blocked, needs-decision, or ready-for-review. Wait for a gate, a check, or a review bot in a background command and keep working; never end a turn to report that you are still waiting.',
  "**Defect-class self-check:** before opening the pull request, check the diff against every class in `.agents/skills/chef/references/defect-classes.md`, fix what applies, and report each class's result in the return. Before every fix push, run `bun scripts/chef/review-threads.ts classes --pr <n>`; on exit 1, push no further patch and return blocked.",
  '**Context:** keep it small. Write gate output to a log and read a failure with a targeted search. A context past about 250K tokens means: write a handoff brief under `tmp/chef/` and hand off to a fresh session.',
  '**Corrections:** after two unsuccessful attempts at the same defect, stop patching and return evidence for causal reassessment.',
];

const defaultVerification = ['bun run check'];

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
  lines.push('## Files', '');
  lines.push(
    ...(paths.length > 0
      ? paths.slice(0, pathLimit).map((path) => `- \`${path}\``)
      : ['- (none named; inspect the nearby code first and keep the change inside one workspace)']),
    '',
    '## Verification',
    '',
    ...(options.verify.length > 0 ? options.verify : defaultVerification).map(
      (command) => `- \`${command}\``,
    ),
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
