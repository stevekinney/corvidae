// Chef command-spelling checker: finds every `bun scripts/chef/<script>.ts <arguments>` invocation
// in prose (the charter rules in `brief.ts`, the chef skill's Markdown) and checks it against the
// script's own `Usage:` header, which is each script's contract for the subcommands and options it
// accepts. A guessed subcommand or option (`review-threads.ts list --repo x`, `worktree-scope.ts
// verify --baseline x`) is reported instead of surviving until a worker types it.
//
// The checker reads only; it runs no script.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const chefDirectory = import.meta.dir;

/** One `Usage:` statement: the optional subcommand and every `--option` the statement spells. */
export interface UsageStatement {
  subcommand: string | undefined;
  options: Set<string>;
}

export interface Invocation {
  script: string;
  tokens: string[];
  /** The code span the invocation came from, whitespace collapsed. */
  span: string;
}

/** The `Usage:` statements in a script's header comment. Empty when the header has none. */
export function usageStatements(script: string): UsageStatement[] {
  const lines = readFileSync(join(chefDirectory, `${script}.ts`), 'utf8').split('\n');
  const header: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith('//')) break;
    header.push(line);
  }
  const statements: UsageStatement[] = [];
  const start = new RegExp(`^//\\s+bun scripts/chef/${script}\\.ts\\b(.*)$`);
  let current: string | undefined;
  const flush = () => {
    if (current === undefined) return;
    const first = current.trim().split(/\s+/)[0] ?? '';
    statements.push({
      subcommand: /^[a-z][a-z-]*$/.test(first) ? first : undefined,
      options: new Set(current.match(/--[a-z][a-z-]*/g) ?? []),
    });
    current = undefined;
  };
  for (const line of header) {
    const opening = start.exec(line);
    if (opening !== null) {
      flush();
      current = opening[1] ?? '';
    } else if (current !== undefined && /^\/\/\s{4,}\S/.test(line)) {
      current += ` ${line.replace(/^\/\/\s+/, '')}`;
    } else flush();
  }
  flush();
  return statements;
}

/**
 * Every inline code span in `text`, whitespace collapsed. Spans are matched line by line, so an odd
 * backtick on one line (or a fenced block) cannot shift the pairing of every span after it.
 */
export function codeSpans(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => [...line.matchAll(/`([^`]+)`/g)])
    .map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim());
}

const invocationPattern = /^(?:bun\s+)?scripts\/chef\/([a-z-]+)\.ts(?:\s+(.*))?$/;

/** The chef script invocations spelled in code spans of `text`. */
export function invocationsIn(text: string): Invocation[] {
  const found: Invocation[] = [];
  for (const span of codeSpans(text)) {
    const match = invocationPattern.exec(span);
    if (match === null) continue;
    // A bare `scripts/chef/x.ts` names the script; it is an invocation only with `bun` or arguments.
    if (!span.startsWith('bun ') && match[2] === undefined) continue;
    found.push({
      script: match[1] as string,
      tokens: (match[2] ?? '').split(' ').filter((token) => token !== ''),
      span,
    });
  }
  return found;
}

/** Why `invocation` is not an accepted spelling, or `undefined` when the script's usage allows it. */
export function problemWith(invocation: Invocation): string | undefined {
  let statements: UsageStatement[];
  try {
    statements = usageStatements(invocation.script);
  } catch {
    return `scripts/chef/${invocation.script}.ts does not exist`;
  }
  if (statements.length === 0)
    return `scripts/chef/${invocation.script}.ts has no Usage statements to check against`;
  const named = new Set(statements.flatMap((statement) => statement.subcommand ?? []));
  const first = invocation.tokens[0];
  let candidates = statements;
  if (named.size > 0 && statements.every((statement) => statement.subcommand !== undefined)) {
    if (first === undefined || !named.has(first))
      return `${first === undefined ? 'no subcommand' : `unknown subcommand ${first}`}; the script accepts ${[...named].join(', ')}`;
    candidates = statements.filter((statement) => statement.subcommand === first);
  } else if (first !== undefined && named.has(first)) {
    candidates = statements.filter((statement) => statement.subcommand === first);
  }
  const accepted = new Set(candidates.flatMap((statement) => [...statement.options]));
  for (const token of invocation.tokens) {
    if (token.startsWith('--') && !accepted.has(token))
      return `unaccepted option ${token}; accepted: ${[...accepted].join(' ') || '(none)'}`;
  }
  return undefined;
}

/** The scripts a stretch of prose names, with or without `bun` and the extension's code span. */
export function scriptsMentioned(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/scripts\/chef\/([a-z-]+)\.ts/g)].map((match) => match[1] as string),
    ),
  ];
}

/**
 * Flag-only code spans (`--fixes-main`, `--waive-load-flake <reason> --control-head <sha>`) name
 * options without naming the script, so each must be accepted by some script that `unit` (a rule or
 * a paragraph) mentions. Returns one problem per option no mentioned script accepts.
 */
export function flagProblemsIn(unit: string): string[] {
  const scripts = scriptsMentioned(unit);
  if (scripts.length === 0) return [];
  const accepted = new Set<string>();
  for (const script of scripts) {
    // A script that does not exist is reported by `problemWith`; it accepts nothing here.
    let statements: UsageStatement[] = [];
    try {
      statements = usageStatements(script);
    } catch {}
    for (const statement of statements) {
      for (const option of statement.options) accepted.add(option);
    }
  }
  const problems: string[] = [];
  for (const span of codeSpans(unit)) {
    if (!span.startsWith('--')) continue;
    for (const token of span.split(' ')) {
      if (token.startsWith('--') && !accepted.has(token))
        problems.push(
          `${token} in \`${span}\` is not accepted by ${scripts.map((script) => `${script}.ts`).join(' or ')}`,
        );
    }
  }
  return problems;
}

/** Every problem in `unit`: invocations that the usage rejects, and flag-only spans nothing accepts. */
export function spellingProblems(unit: string): string[] {
  const problems = invocationsIn(unit).flatMap((invocation) => {
    const problem = problemWith(invocation);
    return problem === undefined ? [] : [`\`${invocation.span}\`: ${problem}`];
  });
  return [...problems, ...flagProblemsIn(unit)];
}

/** Paragraphs of a Markdown file: blank-line separated, so a wrapped sentence stays whole. */
export function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/);
}
