#!/usr/bin/env bun
// Chef triage: a read-only review of COR issues against the Definition of Ready and the repository.
// It never writes Linear: each issue gets findings and a proposed action (keep, needs-refinement
// with a comment draft, propose-backlog) that the coordinator applies, with approval,
// through `linear.ts`.
//
// Usage (the key is LINEAR_API_KEY, resolved as `linear.ts` does):
//   bun scripts/chef/triage.ts ready [--issue COR-n ...] [--state <name>] [--limit n] [--json]
//
// ready  Mechanical Definition-of-Ready checks on the ticket template's sections: every section
//        present and non-empty, acceptance criteria numbered AC1.., Files holding code spans,
//        Verification holding commands, no TBD/TODO, no Decisions line ending in "?", no open
//        "Open questions". Default state: Backlog. Labels and native blockers are not read here;
//        `linear.ts blockers <ID>` still gates promotion.
//
// Exit codes: 0 no blocking findings (advisory template-shape notes do not count), 1 blocking findings, 2 invalid
// usage, 3 Linear unavailable.

import { createClient, LinearError, type LinearClient, type LinearDependencies } from './linear.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';

export type Action = 'keep' | 'needs-refinement' | 'propose-backlog';

export interface Finding {
  code: string;
  message: string;
  /**
   * `advisory` marks a gap in the ticket template's shape that the Definition of Ready does not
   * require (references/linear-policy.md). It is reported, but it never changes the proposed action
   * or the exit code.
   */
  severity?: 'advisory';
}

/** Whether a finding blocks: every finding not marked advisory. */
export function isBlocking(finding: Finding): boolean {
  return finding.severity !== 'advisory';
}

export interface IssueReport {
  identifier: string;
  title: string;
  state: string;
  findings: Finding[];
  action: Action;
  /** A draft for the coordinator to post; present for needs-refinement and propose-backlog. */
  comment?: string;
}

export interface TriageIssue {
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { name: string; type: string };
}

export type TriageDependencies = LinearDependencies;

export const DEFAULT_LIMIT = 50;
const PAGE_LIMIT = 100;
const TEAM = 'COR';

// Markdown reading ------------------------------------------------------------------------------

/**
 * The sections the Definition of Ready requires, by lower-case heading: binary acceptance criteria,
 * exact verification commands, and a delivery boundary (references/linear-policy.md).
 */
export const requiredSections = ['acceptance criteria', 'verification', 'delivery boundary'];

/**
 * The ticket template's other sections. They help a worker, but the Definition of Ready does not
 * require them, so a missing or empty one is advisory. "Decisions" can be absent when the work
 * raised no question; an open question is caught by the marker checks wherever it is written.
 */
export const templateSections = [
  'brief',
  'current behavior',
  'decisions',
  'out of scope',
  'constraints',
  'files',
];

/** The level-2 sections of a description by lower-case heading, with HTML comments removed. */
export function parseSections(description: string): Map<string, string> {
  const sections = new Map<string, string[]>();
  let current: string | undefined;
  let fenced = false;
  for (const line of description.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      current = (heading[1] ?? '').toLowerCase();
      sections.set(current, sections.get(current) ?? []);
    } else if (current !== undefined) {
      sections.get(current)?.push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n').trim()]));
}

/** Inline code spans of `text`. */
export function inlineSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => (match[1] ?? '').trim());
}

/** Every command in `text`: inline code spans, plus each non-empty line of a fenced block. */
function commandCandidates(text: string): string[] {
  const candidates: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (fenced && line.trim() !== '') {
      candidates.push(line.trim());
    } else if (!fenced) {
      candidates.push(...inlineSpans(line));
    }
  }
  return candidates;
}

const commandPattern =
  /^(?:\$\s+)?(?:(?:bun|bunx|git|gh|tsc|node|npx|turbo|prettier|playwright|cd|make)\b|\.\/)/;

/** The commands in `text`: candidates that start with a program the repository runs. */
export function commandsIn(text: string): string[] {
  return commandCandidates(text).filter((candidate) => commandPattern.test(candidate));
}

function stripCode(text: string): string {
  return text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
}

const emptyAnswer = /^(?:[-*]\s*)?(?:\*\*)?(?:none|n\/a|no open questions?)\.?(?:\*\*)?$/i;

// Ready checks ----------------------------------------------------------------------------------

function sectionFindings(sections: Map<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const name of requiredSections) {
    const body = sections.get(name);
    if (body === undefined)
      findings.push({ code: 'section-missing', message: `The "${name}" section is missing.` });
    else if (body === '')
      findings.push({ code: 'section-empty', message: `The "${name}" section is empty.` });
  }
  for (const name of templateSections) {
    const body = sections.get(name);
    if (body === undefined || body === '')
      findings.push({
        code: body === undefined ? 'template-section-missing' : 'template-section-empty',
        message: `The template's "${name}" section is ${body === undefined ? 'missing' : 'empty'}.`,
        severity: 'advisory',
      });
  }
  return findings;
}

function criteriaFindings(criteria: string | undefined): Finding[] {
  if (criteria === undefined || criteria === '') return [];
  const numbers = [...criteria.matchAll(/^\s*(?:[-*]\s*)?\**AC(\d+)\b/gim)].map((match) =>
    Number(match[1]),
  );
  if (numbers.length === 0)
    return [
      {
        code: 'criteria-unnumbered',
        message: 'Acceptance criteria are not numbered AC1, AC2, ….',
        severity: 'advisory',
      },
    ];
  const inOrder = numbers.every((value, index) => value === index + 1);
  return inOrder
    ? []
    : [
        {
          severity: 'advisory',
          code: 'criteria-sequence',
          message: `Acceptance criteria are numbered ${numbers.map((n) => `AC${n}`).join(', ')}, not AC1.. in order.`,
        },
      ];
}

function markerFindings(description: string, sections: Map<string, string>): Finding[] {
  const findings: Finding[] = [];
  const marker = /\b(TBD|TODO|TBC)\b/.exec(stripCode(description.replace(/<!--[\s\S]*?-->/g, '')));
  if (marker !== null)
    findings.push({
      code: 'unanswered-marker',
      message: `The description contains "${marker[1]}".`,
    });
  const question = stripCode(sections.get('decisions') ?? '')
    .split('\n')
    .find((line) => /\?\s*$/.test(line));
  if (question !== undefined)
    findings.push({
      code: 'unanswered-question',
      message: `Decisions has a line ending in a question: "${question.trim()}".`,
    });
  const open = sections.get('open questions') ?? sections.get('open question') ?? '';
  if (open !== '' && !emptyAnswer.test(open))
    findings.push({
      code: 'open-questions',
      message: 'An "Open questions" section still lists questions.',
    });
  return findings;
}

/** The mechanical Definition-of-Ready findings for an issue description. */
export function readyFindings(description: string | null): Finding[] {
  if (description === null || description.trim() === '')
    return [{ code: 'no-description', message: 'The issue has no description.' }];
  const sections = parseSections(description);
  const findings = [
    ...sectionFindings(sections),
    ...criteriaFindings(sections.get('acceptance criteria')),
  ];
  const files = sections.get('files');
  if (files !== undefined && files !== '' && inlineSpans(files).length === 0)
    findings.push({
      code: 'files-no-code-spans',
      message: 'Files lists no code spans, so brief.ts has nothing to hand the worker.',
    });
  const verification = sections.get('verification');
  if (verification !== undefined && verification !== '' && commandsIn(verification).length === 0)
    findings.push({
      code: 'verification-no-commands',
      message: 'Verification holds no commands in code spans.',
    });
  return [...findings, ...markerFindings(description, sections)];
}

// Actions ---------------------------------------------------------------------------------------

/** The proposed action for an issue's findings; the coordinator applies it, with approval. */
export function proposeAction(state: string, all: Finding[]): Action {
  if (all.filter(isBlocking).length === 0) return 'keep';
  return state.trim().toLowerCase() === 'ready' ? 'propose-backlog' : 'needs-refinement';
}

const headline =
  'Triage: this issue does not yet meet the Definition of Ready (references/linear-policy.md).';

/** The comment draft for needs-refinement and propose-backlog; undefined for the other actions. */
export function draftComment(action: Action, findings: Finding[]): string | undefined {
  if (action !== 'needs-refinement' && action !== 'propose-backlog') return undefined;
  const lines = findings.filter(isBlocking).map((finding) => `- ${finding.message}`);
  const ask =
    action === 'propose-backlog'
      ? 'Proposing a move back to Backlog until these are resolved.'
      : 'Please revise the issue to address these before it is claimed.';
  return [headline, '', ...lines, '', ask].join('\n');
}

// Linear reads ----------------------------------------------------------------------------------

const issueFields = 'identifier title description updatedAt state { name type }';

/** A client whose missing-key error reads as Linear being unavailable, not as bad usage. */
function guarded(client: LinearClient): LinearClient {
  return {
    async request<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
      try {
        return await client.request<T>(document, variables);
      } catch (error) {
        if (error instanceof UsageError) throw new LinearError(error.message);
        throw error;
      }
    },
  };
}

async function fetchTriageIssue(client: LinearClient, identifier: string): Promise<TriageIssue> {
  let data: { issue: TriageIssue | null };
  try {
    data = await client.request<{ issue: TriageIssue | null }>(
      `query TriageIssue($id: String!) { issue(id: $id) { ${issueFields} } }`,
      { id: identifier },
    );
  } catch (error) {
    if (error instanceof LinearError && /not found|entity/i.test(error.message))
      throw new UsageError(`No issue ${identifier}.`);
    throw error;
  }
  if (data.issue === null || data.issue === undefined)
    throw new UsageError(`No issue ${identifier}.`);
  return data.issue;
}

async function listTriageIssues(
  client: LinearClient,
  stateName: string,
  limit: number,
): Promise<TriageIssue[]> {
  const filter = { team: { key: { eq: TEAM } }, state: { name: { eq: stateName } } };
  const issues: TriageIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const data: {
      issues: {
        nodes: TriageIssue[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      `query TriageIssues($filter: IssueFilter, $after: String, $first: Int) { issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`,
      { filter, after, first: Math.min(limit, 50) },
    );
    issues.push(...data.issues.nodes);
    if (issues.length >= limit || !data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return issues.slice(0, limit);
}

// Command line ----------------------------------------------------------------------------------

function summarizeIssue(issue: TriageIssue, findings: Finding[]): IssueReport {
  const action = proposeAction(issue.state.name, findings);
  const comment = draftComment(action, findings);
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    findings,
    action,
    ...(comment === undefined ? {} : { comment }),
  };
}

function renderReport(report: IssueReport): string[] {
  const count = report.findings.filter(isBlocking).length;
  return [
    `${report.identifier} [${report.state}] ${report.action} (${count} finding${count === 1 ? '' : 's'}) ${report.title}`,
    ...report.findings.map(
      (finding) => `  ${isBlocking(finding) ? '-' : '·'} ${finding.code}: ${finding.message}`,
    ),
  ];
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} needs a positive integer.`);
  return Number(value);
}

interface Parsed {
  identifiers: string[];
  stateName: string | undefined;
  limit: number;
  json: boolean;
}

function parseArguments(argv: string[]): Parsed {
  const parsed = parseOptions(argv, {
    values: ['state', 'limit'],
    repeated: ['issue'],
    flags: ['json'],
  });
  if (parsed.positionals[0] !== 'ready') throw new UsageError('Usage: triage.ts ready [options].');
  if (parsed.positionals.length > 1)
    throw new UsageError(`Unexpected argument ${parsed.positionals[1]}.`);
  const identifiers = (parsed.repeated['issue'] ?? []).map((value) => {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value))
      throw new UsageError(`--issue needs an identifier such as COR-12, not "${value}".`);
    return value.toUpperCase();
  });
  const stateName = parsed.values['state'];
  if (stateName === '') throw new UsageError('--state needs a state name.');
  return {
    identifiers,
    stateName,
    limit: positiveInteger(parsed.values['limit'], 'limit', DEFAULT_LIMIT),
    json: parsed.flags.has('json'),
  };
}

async function selectIssues(client: LinearClient, options: Parsed): Promise<TriageIssue[]> {
  if (options.identifiers.length > 0) {
    const issues = await Promise.all(
      options.identifiers.map((identifier) => fetchTriageIssue(client, identifier)),
    );
    return options.stateName === undefined
      ? issues
      : issues.filter((issue) => issue.state.name === options.stateName);
  }
  return listTriageIssues(client, options.stateName ?? 'Backlog', options.limit);
}

export async function run(
  argv: string[],
  dependencies: TriageDependencies = {},
): Promise<{ code: number; output: string }> {
  const options = parseArguments(argv);
  const client = guarded(createClient(dependencies));
  const failure = (message: string, code: number) => ({
    code,
    output: options.json ? JSON.stringify({ ok: false, error: message }) : message,
  });
  let reports: IssueReport[];
  try {
    const issues = await selectIssues(client, options);
    reports = issues.map((issue) => summarizeIssue(issue, readyFindings(issue.description)));
  } catch (error) {
    if (error instanceof LinearError) return failure(`Linear is unavailable: ${error.message}`, 3);
    throw error;
  }
  const flagged = reports.filter((report) => report.findings.some(isBlocking));
  const code = flagged.length === 0 ? 0 : 1;
  if (options.json)
    return { code, output: JSON.stringify({ ok: code === 0, command: 'ready', issues: reports }) };
  const head = `ready: ${reports.length} issue${reports.length === 1 ? '' : 's'}, ${flagged.length} with findings.`;
  return { code, output: [head, ...reports.flatMap(renderReport)].join('\n') };
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
