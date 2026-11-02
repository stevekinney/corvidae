#!/usr/bin/env bun
// Chef design ledger: maps every row of an agreed design canvas to the Linear issues that carry it,
// so a design programme cannot lose a row between scoping, a readiness split and delivery. On the
// Oct 29 Interborough canvas, issues listed their rows under "Design source" while their
// acceptance criteria tested behaviour, and a Nov 2 audit found 309 misses; this is the check that
// would have shown it before delivery.
//
// Usage:
//   bun scripts/chef/design-ledger.ts --index <file> --canvas <artifact id>
//                                     [--rows-out <file> [--board-map <file>]] [--json]
//
// `--index` is the canvas's index board saved locally (its `Main.dc.html`, read with the Artifact
// tool's read action), or a Markdown list of `- <id> | <area> | <text> | <status>` lines.
// `--canvas` is the artifact ID the issues link (`claude.ai/artifact/<id>`). Every COR issue whose
// description names it is read, open or closed, and each row is classified:
//   - criterion: the row ID appears in some issue's "Acceptance criteria" section;
//   - deferred: some issue has a line saying the row is deferred (`Deferred: 19b, because …`);
//   - context-only: the row appears in an issue only outside its criteria (a "Design source" list);
//   - unassigned: no issue names the row;
//   - rule: a ticketing-rule row, which governs scoping and is never built.
// Context-only and unassigned rows are gaps. Dated revision sections apply in order (`brief.ts`
// `rowCarriage`): a revision clause naming a row carries it unless it says the row moved, was
// dropped or was removed.
//
// `--rows-out` also writes the design-review skill's rows file for a drift audit: every index row,
// `row-id | board | requirement text [Status]`. `--board-map` names each row's board, from
// `row-id | board` lines or a drift report's `## Board (index rows: …)` headings; unmapped rows
// go to `Main`.
//
// Exit codes: 0 every row is a criterion, deferred or a rule; 1 gaps, or a Linear failure;
// 2 invalid CLI usage.

import { readFileSync, writeFileSync } from 'node:fs';
import { mentionsRow, rowCarriage } from './brief.ts';
import { createClient, type LinearClient, type LinearDependencies, LinearError } from './linear.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';

export interface CanvasRow {
  id: string;
  area: string;
  text: string;
  status: string;
}

export type Coverage = 'criterion' | 'deferred' | 'context-only' | 'unassigned' | 'rule';

export interface LedgerRow extends CanvasRow {
  coverage: Coverage;
  criterionIssues: string[];
  deferredIssues: string[];
  contextIssues: string[];
}

export interface Ledger {
  rows: LedgerRow[];
  gaps: LedgerRow[];
  issueCount: number;
}

export interface LedgerIssue {
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string };
}

const rowIdPattern = /^\d{2}[a-z]$/;

/** The rows of a canvas index: the board's `var rows = [...]` array, or `- id | area | text | status` lines. */
export function parseCanvasRows(text: string): CanvasRow[] {
  const rows: CanvasRow[] = [];
  const quoted =
    /\[\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'((?:[^'\\]|\\.)*)'(?:\s*,\s*'([^']*)')?\s*\]/g;
  for (const match of text.matchAll(quoted)) {
    const id = match[1] ?? '';
    if (rowIdPattern.test(id))
      rows.push({ id, area: match[2] ?? '', text: match[3] ?? '', status: match[4] ?? '' });
  }
  if (rows.length > 0) return rows;
  for (const line of text.split('\n')) {
    const cells = /^\s*-\s+(.*)$/
      .exec(line)?.[1]
      ?.split('|')
      .map((cell) => cell.trim());
    if (cells === undefined || !rowIdPattern.test(cells[0] ?? '')) continue;
    rows.push({
      id: cells[0] ?? '',
      area: cells[1] ?? '',
      text: cells[2] ?? '',
      status: cells[3] ?? '',
    });
  }
  return rows;
}

/** Classifies every canvas row by where the issues carry it. Pure. */
export function buildLedger(rows: CanvasRow[], issues: LedgerIssue[]): Ledger {
  const ids = rows.map((row) => row.id);
  const carried = issues.map((issue) => ({
    issue,
    description: issue.description ?? '',
    carriage: rowCarriage(issue.description ?? '', ids),
  }));
  const ledgerRows = rows.map((row): LedgerRow => {
    const criterionIssues: string[] = [];
    const deferredIssues: string[] = [];
    const contextIssues: string[] = [];
    for (const { issue, description, carriage } of carried) {
      if (carriage.criteria.has(row.id)) criterionIssues.push(issue.identifier);
      else if (carriage.deferred.has(row.id)) deferredIssues.push(issue.identifier);
      else if (mentionsRow(description, row.id)) contextIssues.push(issue.identifier);
    }
    const coverage: Coverage = /ticketing rule/i.test(row.area)
      ? 'rule'
      : criterionIssues.length > 0
        ? 'criterion'
        : deferredIssues.length > 0
          ? 'deferred'
          : contextIssues.length > 0
            ? 'context-only'
            : 'unassigned';
    return { ...row, coverage, criterionIssues, deferredIssues, contextIssues };
  });
  return {
    rows: ledgerRows,
    gaps: ledgerRows.filter(
      (row) => row.coverage === 'context-only' || row.coverage === 'unassigned',
    ),
    issueCount: issues.length,
  };
}

/** One line per row (`<id> | <coverage> | <issues>`), then a summary line. */
export function renderLedger(ledger: Ledger): string {
  const issuesOf = (row: LedgerRow) =>
    [...row.criterionIssues, ...row.deferredIssues, ...row.contextIssues].join(', ');
  const counts = new Map<Coverage, number>();
  for (const row of ledger.rows) counts.set(row.coverage, (counts.get(row.coverage) ?? 0) + 1);
  const summary = [...counts].map(([coverage, count]) => `${count} ${coverage}`).join(', ');
  return [
    ...ledger.rows.map((row) => `${row.id} | ${row.coverage} | ${issuesOf(row)}`),
    '',
    `${ledger.rows.length} rows across ${ledger.issueCount} issues: ${summary}. ${ledger.gaps.length} gaps${ledger.gaps.length > 0 ? `: ${ledger.gaps.map((row) => row.id).join(', ')}` : ''}.`,
  ].join('\n');
}

/**
 * Which board each row belongs to, from a map file: `row-id | board` lines, or the drift audit's
 * Markdown headings (`## ChatSession (index rows: 12a, 12c)`), where a board named `…Before` yields
 * to any other board that names the row. A row the map does not name is drawn on the index board
 * itself, `Main`.
 */
export function parseBoardMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const pair = /^\s*(\d{2}[a-z])\s*\|\s*([\w.-]+)\s*$/.exec(line);
    if (pair !== null) {
      map.set(pair[1] ?? '', (pair[2] ?? '').replace(/\.dc\.html$/, ''));
      continue;
    }
    const heading = /^#{1,6}\s+([\w.-]+)\s+\(index rows?:\s*([^)]*)\)/.exec(line);
    if (heading === null) continue;
    for (const id of (heading[2] ?? '').match(/\b\d{2}[a-z]\b/g) ?? [])
      // The first board that names a row wins, except that a "before" board yields to any other.
      if (!map.has(id) || /before$/i.test(map.get(id) ?? ''))
        map.set(id, (heading[1] ?? '').replace(/\.dc\.html$/, ''));
  }
  return map;
}

/**
 * The design-review rows file for a drift audit: every index row, in index order, as
 * `row-id | board | requirement text [Status]`, with any `|` in the text written as `/`.
 */
export function renderRowsFile(rows: CanvasRow[], boards: Map<string, string>): string {
  return rows
    .map((row) => {
      const status = row.status === '' ? 'Prototyped' : row.status;
      const text = `${row.text} [${status}]`.replaceAll('|', '/');
      return `${row.id} | ${boards.get(row.id) ?? 'Main'} | ${text}`;
    })
    .join('\n')
    .concat('\n');
}

/** Pages of 100 issues read before `searchIssues` gives up rather than return a partial list. */
export const issuePageLimit = 50;

/** Every issue, open or closed, whose description contains `term`. */
export async function searchIssues(client: LinearClient, term: string): Promise<LedgerIssue[]> {
  const found: LedgerIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < issuePageLimit; page += 1) {
    const data: {
      issues: {
        nodes: LedgerIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      `query DesignLedger($term: String!, $after: String) { issues(first: 100, after: $after, includeArchived: true, filter: { description: { contains: $term } }) { nodes { identifier title description state { name } } pageInfo { hasNextPage endCursor } } }`,
      { term, after },
    );
    found.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return found;
    after = data.issues.pageInfo.endCursor;
  }
  throw new LinearError(
    `More than ${issuePageLimit * 100} issues name ${term}; refusing to report a partial ledger.`,
  );
}

export async function run(
  argv: string[],
  dependencies: LinearDependencies = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['index', 'canvas', 'rows-out', 'board-map'],
    flags: ['json'],
  });
  const indexPath = parsed.values['index'];
  const canvas = parsed.values['canvas'];
  if (indexPath === undefined || canvas === undefined || parsed.positionals.length > 0)
    throw new UsageError(
      'Usage: design-ledger.ts --index <file> --canvas <artifact id> [--rows-out <file> [--board-map <file>]] [--json]',
    );
  const rows = parseCanvasRows(readFileSync(indexPath, 'utf8'));
  if (rows.length === 0) throw new UsageError(`No design rows found in ${indexPath}.`);
  const rowsOut = parsed.values['rows-out'];
  if (rowsOut !== undefined) {
    const mapPath = parsed.values['board-map'];
    const boards =
      mapPath === undefined
        ? new Map<string, string>()
        : parseBoardMap(readFileSync(mapPath, 'utf8'));
    writeFileSync(rowsOut, renderRowsFile(rows, boards));
  }
  try {
    const ledger = buildLedger(rows, await searchIssues(createClient(dependencies), canvas));
    const code = ledger.gaps.length === 0 ? 0 : 1;
    return {
      code,
      output: parsed.flags.has('json')
        ? JSON.stringify({ ok: code === 0, ...ledger })
        : renderLedger(ledger),
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
