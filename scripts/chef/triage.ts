#!/usr/bin/env bun
// Chef triage: a read-only review of COR issues against the Definition of Ready and the repository.
// It never writes Linear: each issue gets findings and a proposed action (keep, needs-refinement
// with a comment draft, propose-close, propose-backlog) that the coordinator applies, with approval,
// through `linear.ts`.
//
// Usage (the key is LINEAR_API_KEY, resolved as `linear.ts` does; `gh` must be signed in for the
// stale and done commands; `--jev shadow` needs JEV credentials and is advisory only):
//   bun scripts/chef/triage.ts ready [--issue COR-n ...] [--state <name>] [--limit n] [--jev shadow|off] [--json]
//   bun scripts/chef/triage.ts done  [--since <date>] [--limit n] [--json]
//   bun scripts/chef/triage.ts stale [--issue COR-n ...] [--state <name>] [--limit n] [--jev shadow|off] [--json]
//
// ready  Mechanical Definition-of-Ready checks on the ticket template's sections: every section
//        present and non-empty, acceptance criteria numbered AC1.., Files holding code spans,
//        Verification holding commands, no TBD/TODO, no Decisions line ending in "?", no open
//        "Open questions". Default state: Backlog. Labels and native blockers are not read here;
//        `linear.ts blockers <ID>` still gates promotion.
// done   Completed issues (since --since, default 30 days) with no merged pull request that
//        references them with a linking word (`drift.ts`'s rule) and no execution-report comment
//        (first line "Execution report: <branch> attempt <n>", see `deliver.ts`).
// stale  Open issues (or those in --state) whose Files paths are gone, whose backticked symbols no
//        longer appear in the repository (`git grep`), whose listed files have commits since the
//        issue's updatedAt, that name COR issues already Done or Canceled, or that a merged pull
//        request references.
//
// --jev shadow asks the Jev predicates criteria-binary, verification-exact and unanswered-question
// (ready) and premise-stale and already-done (stale) and prints the answers as advisory; they never
// change a finding, an action or the exit code. The default is off.
//
// Exit codes: 0 no blocking findings (advisory template-shape notes do not count), 1 blocking findings (or a gh or git read failed, named in the output), 2 invalid
// usage, 3 Linear unavailable.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchPullRequests,
  GitHubError,
  pullRequestsFor,
  referencedIn,
  type PullRequest,
} from './drift.ts';
import { shadow } from './jev-predicates.ts';
import { createClient, LinearError, type LinearClient, type LinearDependencies } from './linear.ts';
import {
  defaultRunner,
  describeError,
  emitResult,
  parseOptions,
  UsageError,
  type Runner,
} from './process-runner.ts';

export type Command = 'ready' | 'done' | 'stale';
export type Action = 'keep' | 'needs-refinement' | 'propose-close' | 'propose-backlog';

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

export interface Advisory {
  predicate: string;
  decision: string | null;
  confidence: number | null;
  outcome: string;
}

export interface IssueReport {
  identifier: string;
  title: string;
  state: string;
  findings: Finding[];
  action: Action;
  /** A draft for the coordinator to post; present for needs-refinement and propose-backlog. */
  comment?: string;
  advisory: Advisory[];
}

export interface TriageIssue {
  identifier: string;
  title: string;
  description: string | null;
  updatedAt: string;
  state: { name: string; type: string };
}

export type ShadowCall = (
  predicate: string,
  evidence: Record<string, unknown>,
) => Promise<{ decision: string | null; confidence: number | null; outcome: string }>;

export interface TriageDependencies extends LinearDependencies {
  runner?: Runner;
  now?: () => Date;
  /** Whether a repository-relative path exists; defaults to the filesystem under the cwd. */
  pathExists?: (path: string) => boolean;
  shadow?: ShadowCall;
}

export const DEFAULT_LIMIT = 50;
export const DEFAULT_SINCE_DAYS = 30;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;
const SYMBOL_LIMIT = 25;
const COMMIT_LIMIT = 20;
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

// Stale checks ----------------------------------------------------------------------------------

const extensionPattern = /\.(?:ts|tsx|js|json|md|svelte|toml|ya?ml|sh|css|html|lock|mjs|cjs)$/;

/** The repository path a Files code span names, or undefined when it is not one. */
export function pathOf(span: string): string | undefined {
  const bare = span
    .replace(/^\.\//, '')
    .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?:-\d+)?)$/, '')
    .trim();
  if (!/^[\w@.\-/]+$/.test(bare) || bare.includes('*')) return undefined;
  return bare.includes('/') || extensionPattern.test(bare) ? bare : undefined;
}

/**
 * The identifier-like code spans in Current behavior that look like symbols, as their last
 * segment. Only that section describes existing code; the others may name symbols the issue will
 * add, which are not stale for being absent.
 */
export function symbolsOf(description: string): string[] {
  const text = parseSections(description).get('current behavior') ?? '';
  const found = new Set<string>();
  for (const span of inlineSpans(text)) {
    const name = span.replace(/\(\)$/, '');
    if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(name)) continue;
    const last = name.split('.').at(-1) ?? '';
    if (name.includes('.') && extensionPattern.test(`.${last}`)) continue;
    const distinctive =
      /[a-z][A-Z]/.test(name) ||
      /^[A-Z][a-z0-9]+[A-Z]/.test(name) ||
      name.includes('_') ||
      name.includes('.') ||
      span.endsWith('()');
    if (distinctive && last.length >= 4) found.add(last);
  }
  return [...found].slice(0, SYMBOL_LIMIT);
}

export function referencedIssues(description: string, own: string): string[] {
  const found = new Set(
    (description.match(/(?<![A-Za-z0-9])COR-\d+(?![A-Za-z0-9])/gi) ?? []).map((identifier) =>
      identifier.toUpperCase(),
    ),
  );
  found.delete(own.toUpperCase());
  return [...found];
}

export interface StaleContext {
  runner: Runner;
  pathExists: (path: string) => boolean;
  pullRequests: PullRequest[];
  issueState: (identifier: string) => Promise<{ name: string; type: string } | undefined>;
}

const isMerged = (pullRequest: PullRequest) =>
  pullRequest.mergedAt !== null || pullRequest.state === 'MERGED';

/** A failed `git` read, reported rather than read as "nothing found". */
export class GitError extends Error {}

function gitSearchHas(runner: Runner, symbol: string): boolean {
  const result = runner(['git', 'grep', '-q', '-n', '-F', '--', symbol]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GitError(`git grep failed (exit ${result.code}): ${result.stderr.trim()}`);
}

function commitsSince(runner: Runner, since: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  const result = runner([
    'git',
    'log',
    `--since=${since}`,
    '-n',
    String(COMMIT_LIMIT),
    '--format=%h %s',
    '--',
    ...paths,
  ]);
  if (result.code !== 0)
    throw new GitError(`git log failed (exit ${result.code}): ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

/** The staleness findings for one open issue, against the repository and the pull requests. */
export async function staleFindings(issue: TriageIssue, context: StaleContext): Promise<Finding[]> {
  const description = issue.description ?? '';
  const findings: Finding[] = [];
  const sections = parseSections(description);
  const paths = [...new Set(inlineSpans(sections.get('files') ?? '').map(pathOf))].filter(
    (path): path is string => path !== undefined,
  );
  const existing = paths.filter((path) => context.pathExists(path));
  for (const path of paths.filter((candidate) => !existing.includes(candidate)))
    findings.push({
      code: 'missing-file',
      message: `Files lists ${path}, which no longer exists.`,
    });
  for (const symbol of symbolsOf(description))
    if (!gitSearchHas(context.runner, symbol))
      findings.push({
        code: 'missing-symbol',
        message: `The symbol ${symbol} no longer appears in the repository.`,
      });
  const commits = commitsSince(context.runner, issue.updatedAt, existing);
  if (commits.length > 0)
    findings.push({
      code: 'files-changed',
      message: `${commits.length} commit${commits.length === 1 ? '' : 's'} touched the listed files since ${issue.updatedAt}: ${commits.slice(0, 3).join('; ')}.`,
    });
  for (const identifier of referencedIssues(description, issue.identifier)) {
    const state = await context.issueState(identifier);
    if (state !== undefined && (state.type === 'completed' || state.type === 'canceled'))
      findings.push({
        code: 'referenced-closed',
        message: `${identifier} is referenced but is already ${state.name}.`,
      });
  }
  for (const pullRequest of pullRequestsFor(context.pullRequests, issue.identifier).filter(
    isMerged,
  ))
    findings.push({
      code: 'merged-pr',
      message: `Pull request #${pullRequest.number} references it and has merged.`,
    });
  return findings;
}

// Done checks -----------------------------------------------------------------------------------

const executionReportMarker = /^Execution report: \S+ attempt [1-9]\d*$/;

/** Whether a comment body is an execution report (its first non-empty line is the marker). */
export function isExecutionReport(body: string): boolean {
  return executionReportMarker.test(
    (body.split('\n').find((line) => line.trim() !== '') ?? '').trim(),
  );
}

/** The no-evidence finding for a Done issue, or none when a linked merge or a report exists. */
export function doneFindings(
  issue: TriageIssue,
  pullRequests: PullRequest[],
  comments: string[],
): Finding[] {
  const merged = pullRequests.filter(
    (pullRequest) =>
      isMerged(pullRequest) && referencedIn(pullRequest.body).has(issue.identifier.toUpperCase()),
  );
  if (merged.length > 0 || comments.some(isExecutionReport)) return [];
  return [
    {
      code: 'no-evidence',
      message:
        'Done with no merged pull request that references it with a linking word and no execution-report comment.',
    },
  ];
}

// Actions ---------------------------------------------------------------------------------------

const premiseCodes = new Set(['missing-file', 'missing-symbol', 'referenced-closed']);

/** The proposed action for an issue's findings; the coordinator applies it, with approval. */
export function proposeAction(command: Command, state: string, all: Finding[]): Action {
  const findings = all.filter(isBlocking);
  if (findings.length === 0) return 'keep';
  const ready = state.trim().toLowerCase() === 'ready';
  if (command === 'stale') {
    if (findings.some((finding) => finding.code === 'merged-pr')) return 'propose-close';
    if (ready && findings.some((finding) => premiseCodes.has(finding.code)))
      return 'propose-backlog';
    return 'needs-refinement';
  }
  if (command === 'ready' && ready) return 'propose-backlog';
  return 'needs-refinement';
}

const headlines: Record<Command, string> = {
  ready:
    'Triage: this issue does not yet meet the Definition of Ready (references/linear-policy.md).',
  stale: 'Triage: this issue no longer matches the repository.',
  done: 'Triage: this issue is Done without recorded evidence.',
};

/** The comment draft for needs-refinement and propose-backlog; undefined for the other actions. */
export function draftComment(
  command: Command,
  action: Action,
  findings: Finding[],
): string | undefined {
  if (action !== 'needs-refinement' && action !== 'propose-backlog') return undefined;
  const lines = findings.filter(isBlocking).map((finding) => `- ${finding.message}`);
  const ask =
    action === 'propose-backlog'
      ? 'Proposing a move back to Backlog until these are resolved.'
      : command === 'done'
        ? 'Add a completion comment (an execution report) or link the merged pull request with a linking word.'
        : 'Please revise the issue to address these before it is claimed.';
  return [headlines[command], '', ...lines, '', ask].join('\n');
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

interface ListOptions {
  mode: 'open' | 'completed';
  stateName: string | undefined;
  since: string | undefined;
  limit: number;
}

async function listTriageIssues(
  client: LinearClient,
  options: ListOptions,
): Promise<TriageIssue[]> {
  const state =
    options.stateName !== undefined
      ? { name: { eq: options.stateName } }
      : options.mode === 'completed'
        ? { type: { eq: 'completed' } }
        : { type: { nin: ['completed', 'canceled'] } };
  const filter = {
    team: { key: { eq: TEAM } },
    state,
    ...(options.since === undefined ? {} : { completedAt: { gte: options.since } }),
  };
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
      { filter, after, first: Math.min(options.limit, 50) },
    );
    issues.push(...data.issues.nodes);
    if (issues.length >= options.limit || !data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return issues.slice(0, options.limit);
}

async function fetchCommentBodies(client: LinearClient, identifier: string): Promise<string[]> {
  const data = await client.request<{ issue: { comments: { nodes: { body: string }[] } } | null }>(
    `query TriageComments($id: String!) { issue(id: $id) { comments(first: 250) { nodes { body } } } }`,
    { id: identifier },
  );
  return (data.issue?.comments.nodes ?? []).map((comment) => comment.body);
}

function issueStateReader(client: LinearClient): StaleContext['issueState'] {
  const cache = new Map<string, { name: string; type: string } | undefined>();
  return async (identifier) => {
    if (cache.has(identifier)) return cache.get(identifier);
    let state: { name: string; type: string } | undefined;
    try {
      const data = await client.request<{
        issue: { state: { name: string; type: string } } | null;
      }>(`query TriageReferenced($id: String!) { issue(id: $id) { state { name type } } }`, {
        id: identifier,
      });
      state = data.issue?.state;
    } catch (error) {
      if (!(error instanceof LinearError && /not found|entity/i.test(error.message))) throw error;
    }
    cache.set(identifier, state);
    return state;
  };
}

// Jev advisories --------------------------------------------------------------------------------

const defaultShadow: ShadowCall = async (predicate, evidence) => {
  const entry = await shadow(predicate, evidence);
  return { decision: entry.decision, confidence: entry.confidence, outcome: entry.outcome };
};

async function advise(
  call: ShadowCall,
  predicates: string[],
  evidence: Record<string, unknown>,
): Promise<Advisory[]> {
  const advisory: Advisory[] = [];
  for (const predicate of predicates) {
    try {
      advisory.push({ predicate, ...(await call(predicate, evidence)) });
    } catch (error) {
      advisory.push({
        predicate,
        decision: null,
        confidence: null,
        outcome: `error ${describeError(error)}`,
      });
    }
  }
  return advisory;
}

function readyEvidence(issue: TriageIssue): Record<string, unknown> {
  const sections = parseSections(issue.description ?? '');
  return {
    identifier: issue.identifier,
    brief: present(sections, 'brief'),
    criteria: present(sections, 'acceptance criteria'),
    decisions: present(sections, 'decisions'),
    openQuestions: present(sections, 'open questions'),
    verification: present(sections, 'verification'),
    files: inlineSpans(sections.get('files') ?? ''),
  };
}

/**
 * A section's text, or a statement that the issue has none. Absence is a known fact about the
 * issue, and Jev read the shadow log's former `unknown` as a possibly open question (2026-11-09:
 * `unanswered-question` answered yes for all eight pre-template issues it saw).
 */
export function present(sections: Map<string, string>, name: string): string {
  const body = sections.get(name);
  if (body === undefined) return `none: the issue has no "${name}" section`;
  return body === '' ? `none: the "${name}" section is empty` : body;
}

function staleEvidence(issue: TriageIssue, findings: Finding[]): Record<string, unknown> {
  return {
    identifier: issue.identifier,
    title: issue.title,
    findings: findings.map((finding) => finding.message),
    mergedPullRequests: findings
      .filter((finding) => finding.code === 'merged-pr')
      .map((finding) => finding.message),
  };
}

// Command line ----------------------------------------------------------------------------------

function summarizeIssue(
  command: Command,
  issue: TriageIssue,
  findings: Finding[],
  advisory: Advisory[],
): IssueReport {
  const action = proposeAction(command, issue.state.name, findings);
  const comment = draftComment(command, action, findings);
  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    findings,
    action,
    ...(comment === undefined ? {} : { comment }),
    advisory,
  };
}

function renderReport(report: IssueReport): string[] {
  const count = report.findings.filter(isBlocking).length;
  return [
    `${report.identifier} [${report.state}] ${report.action} (${count} finding${count === 1 ? '' : 's'}) ${report.title}`,
    ...report.findings.map(
      (finding) => `  ${isBlocking(finding) ? '-' : '·'} ${finding.code}: ${finding.message}`,
    ),
    ...report.advisory.map(
      (entry) =>
        `  ~ ${entry.predicate}: ${entry.decision ?? 'no answer'}${entry.confidence === null ? '' : ` (${entry.confidence.toFixed(2)})`} [advisory, ${entry.outcome}]`,
    ),
  ];
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} needs a positive integer.`);
  return Number(value);
}

function parseSince(value: string | undefined, now: Date): string {
  if (value === undefined)
    return new Date(now.getTime() - DEFAULT_SINCE_DAYS * DAY_MILLISECONDS).toISOString();
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new UsageError('--since needs a date such as 2026-10-01.');
  return new Date(time).toISOString();
}

interface Parsed {
  command: Command;
  identifiers: string[];
  stateName: string | undefined;
  limit: number;
  shadowOn: boolean;
  since: string;
  json: boolean;
}

function parseArguments(argv: string[], now: Date): Parsed {
  const parsed = parseOptions(argv, {
    values: ['state', 'limit', 'jev', 'since'],
    repeated: ['issue'],
    flags: ['json'],
  });
  const command = parsed.positionals[0];
  if (command !== 'ready' && command !== 'done' && command !== 'stale')
    throw new UsageError('Usage: triage.ts ready|done|stale [options].');
  if (parsed.positionals.length > 1)
    throw new UsageError(`Unexpected argument ${parsed.positionals[1]}.`);
  const names = [...Object.keys(parsed.values), ...Object.keys(parsed.repeated)];
  const allowed = command === 'done' ? ['limit', 'since'] : ['state', 'limit', 'jev', 'issue'];
  const stray = names.find((name) => !allowed.includes(name));
  if (stray !== undefined) throw new UsageError(`--${stray} does not apply to ${command}.`);
  const jev = parsed.values['jev'] ?? 'off';
  if (jev !== 'shadow' && jev !== 'off') throw new UsageError('--jev needs shadow or off.');
  const identifiers = (parsed.repeated['issue'] ?? []).map((value) => {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value))
      throw new UsageError(`--issue needs an identifier such as COR-12, not "${value}".`);
    return value.toUpperCase();
  });
  const stateName = parsed.values['state'];
  if (stateName === '') throw new UsageError('--state needs a state name.');
  return {
    command,
    identifiers,
    stateName,
    limit: positiveInteger(parsed.values['limit'], 'limit', DEFAULT_LIMIT),
    shadowOn: jev === 'shadow',
    since: parseSince(parsed.values['since'], now),
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
  const ready = options.command === 'ready';
  return listTriageIssues(client, {
    mode: options.command === 'done' ? 'completed' : 'open',
    stateName: ready ? (options.stateName ?? 'Backlog') : options.stateName,
    since: options.command === 'done' ? options.since : undefined,
    limit: options.limit,
  });
}

async function analyze(
  options: Parsed,
  issues: TriageIssue[],
  client: LinearClient,
  dependencies: TriageDependencies,
): Promise<IssueReport[]> {
  const runner = dependencies.runner ?? defaultRunner;
  const call = options.shadowOn ? (dependencies.shadow ?? defaultShadow) : undefined;
  const reports: IssueReport[] = [];
  if (options.command === 'ready') {
    for (const issue of issues) {
      const advisory =
        call === undefined
          ? []
          : await advise(
              call,
              ['criteria-binary', 'verification-exact', 'unanswered-question'],
              readyEvidence(issue),
            );
      reports.push(summarizeIssue('ready', issue, readyFindings(issue.description), advisory));
    }
    return reports;
  }
  const pullRequests = fetchPullRequests(runner);
  if (options.command === 'done') {
    for (const issue of issues) {
      const comments = await fetchCommentBodies(client, issue.identifier);
      reports.push(summarizeIssue('done', issue, doneFindings(issue, pullRequests, comments), []));
    }
    return reports;
  }
  const context: StaleContext = {
    runner,
    pathExists: dependencies.pathExists ?? ((path) => existsSync(join(process.cwd(), path))),
    pullRequests,
    issueState: issueStateReader(client),
  };
  for (const issue of issues) {
    const findings = await staleFindings(issue, context);
    const advisory =
      call === undefined
        ? []
        : await advise(call, ['premise-stale', 'already-done'], staleEvidence(issue, findings));
    reports.push(summarizeIssue('stale', issue, findings, advisory));
  }
  return reports;
}

export async function run(
  argv: string[],
  dependencies: TriageDependencies = {},
): Promise<{ code: number; output: string }> {
  const now = (dependencies.now ?? (() => new Date()))();
  const options = parseArguments(argv, now);
  const client = guarded(createClient(dependencies));
  const failure = (message: string, code: number) => ({
    code,
    output: options.json ? JSON.stringify({ ok: false, error: message }) : message,
  });
  let reports: IssueReport[];
  try {
    const issues = await selectIssues(client, options);
    reports = await analyze(options, issues, client, dependencies);
  } catch (error) {
    if (error instanceof LinearError) return failure(`Linear is unavailable: ${error.message}`, 3);
    if (error instanceof GitHubError || error instanceof GitError)
      return failure(`A read failed, so no triage was made: ${error.message}`, 1);
    throw error;
  }
  const flagged = reports.filter((report) => report.findings.some(isBlocking));
  const code = flagged.length === 0 ? 0 : 1;
  if (options.json)
    return {
      code,
      output: JSON.stringify({ ok: code === 0, command: options.command, issues: reports }),
    };
  const head = `${options.command}: ${reports.length} issue${reports.length === 1 ? '' : 's'}, ${flagged.length} with findings.`;
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
