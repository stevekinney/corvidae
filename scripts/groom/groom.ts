#!/usr/bin/env bun
// Chef groom: the readiness gate for COR issues. For each open Backlog issue (or each one named with
// `--issue`), it asks Jev one batch of questions about the issue, then, without asking anyone:
//
//   - sets a priority when the issue has none (a priority someone set is never changed);
//   - adds the Work Type label when the issue has none, and each package label whose workspace the
//     work changes;
//   - checks the Definition of Ready (references/linear-policy.md): the mechanical predicates in
//     code (`triage.ts`'s section and citation checks, exactly one Work Type label, no open
//     blocker), the judgment ones as Jev questions (`groom-questions.ts`);
//   - moves an issue that passes to Ready, and records the result in one "Groom:" comment per
//     issue, updated in place on later runs.
//
// Every write is read back. An issue that fails stays in Backlog; its findings say whether a
// rewrite can fix each one (`rewrite`) or the owner has to answer (`owner`), which the `groom` skill
// acts on.
//
// The comment ends with a record of what Jev read: a hash of the text it judged and each readiness
// probability. While the text is unchanged a later run reuses those readings instead of asking
// again, so a reading near a threshold cannot flip between runs on the same words. A changed title
// or description asks again.
//
// Usage (LINEAR_API_KEY and TYPESAFE_API_KEY resolve through credentials.ts; neither is printed):
//   bun scripts/groom/groom.ts [--issue COR-n ...] [--limit n] [--dry-run] [--json]
//   bun scripts/groom/groom.ts --clear-open-choice COR-n --reason <text> [--dry-run] [--json]
//
// `--dry-run` asks Jev and reports what it would write, writing nothing.
//
// `--clear-open-choice` is the groom skill's verdict on an unsettled open-choice reading: having
// read the issue and found no choice left for the owner, it records the reason, and the reading
// passes for this exact text. Only a reading inside the unsettled band can be cleared; a clear yes
// goes to the owner, and any change to the text asks Jev again and drops the verdict.
//
// Exit codes: 0 every issue is Ready, 1 an issue stays in Backlog, 2 invalid usage, 3 Linear or Jev
// unavailable (a failed Jev call is an error, never an answer).

import type {
  Decision,
  DecisionBatch,
  DecisionBatchResult,
  DecisionQuestion,
} from '@lostgradient/operative';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripShared } from '../chef/brief.ts';
import { resolveCredential } from '../chef/credentials.ts';
import {
  addLabels,
  createClient,
  fetchComments,
  LinearError,
  openBlockers,
  postComment,
  setPriority,
  setState,
  teamLabels,
  updateComment,
  type Blocker,
  type LinearClient,
  type LinearDependencies,
  type Outcome,
  type PriorityName,
} from '../chef/linear.ts';
import { emitResult, parseOptions, UsageError } from '../chef/process-runner.ts';
import {
  citationFindings,
  citationsIn,
  isBlocking,
  loadRepository,
  parseSections,
  readyFindings,
  type RepositoryView,
} from '../chef/triage.ts';
import {
  noThreshold,
  packageQuestion,
  priorityOrder,
  priorityQuestion,
  readinessQuestions,
  workTypeOptions,
  workTypeQuestion,
  yesThreshold,
} from './groom-questions.ts';

const TEAM = 'COR';
/** The readiness question a groom verdict may clear. */
const OPEN_CHOICE = 'no-open-choice';
const BACKLOG = 'Backlog';
const READY = 'Ready';
const PAGE_LIMIT = 100;
const WORK_TYPE_PREFIX = 'type:';
const PACKAGE_PREFIX = 'package:';
/** The first line of the comment the groomer owns on each issue. */
export const commentMarker = 'Groom:';

/** The workspace folders whose packages a `package:` label can name. */
const workspaceRoots = ['applications', 'components', 'packages', 'plugins', 'internal', 'testing'];

/** Asks Jev a batch of questions about one issue; a failed call throws. */
export type Decide = (batch: DecisionBatch) => Promise<DecisionBatchResult>;

export interface GroomDependencies extends LinearDependencies {
  /** Jev; the default is the `typesafe` provider's Jev with TYPESAFE_API_KEY. Tests pass recorded answers. */
  decide?: Decide;
  /** What `origin/main` holds, for citation checks; the default reads it with git. */
  repository?: () => RepositoryView;
  /** The workspaces a `package:` label can name; the default reads the working tree. */
  workspaces?: () => Workspace[];
  /** Today's date as `YYYY-MM-DD`, for an open-choice verdict; the default is the UTC date. */
  today?: () => string;
}

/** A workspace a `package:` label names: `package:<name>` for the folder `<root>/<name>`. */
export interface Workspace {
  name: string;
  path: string;
  /** Its `package.json` description, the fact Jev needs to judge whether work touches it. */
  about: string;
}

export interface GroomIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { name: string };
  team: { id: string; key: string; parent: { id: string } | null };
  labels: { nodes: { name: string }[] };
}

/**
 * What a failed predicate needs: a rewrite of the issue, an answer from the owner, or only time (an
 * open blocker that is still being worked).
 */
export type Need = 'rewrite' | 'owner' | 'wait';

export interface GroomFinding {
  code: string;
  message: string;
  need: Need;
}

export interface GroomReport {
  identifier: string;
  title: string;
  /** The priority set this run; absent when the issue had one or Jev was not asked. */
  priority?: PriorityName;
  labelsAdded: string[];
  /** Package labels Jev could not settle, left off. */
  labelsUnsettled: string[];
  ready: boolean;
  findings: GroomFinding[];
  /** The writes this run made (or would make, with `--dry-run`). */
  writes: string[];
  /** Each question Jev answered: the probability of yes for a yes/no question, the value otherwise. */
  answers: Record<string, number | string | boolean>;
  /** Readiness questions answered from the last run's record because the text is unchanged. */
  reused: string[];
  /** The groom verdict that passes an unsettled open-choice reading for this text, when one holds. */
  cleared?: OpenChoiceVerdict;
}

/** The groom skill's verdict that an unsettled open-choice reading leaves nothing for the owner. */
export interface OpenChoiceVerdict {
  date: string;
  reason: string;
}

/**
 * What a run read, kept at the end of its comment: a hash of the text Jev judged, each readiness
 * probability of yes, and any open-choice verdict.
 */
export interface GroomRecord {
  text: string;
  readings: Map<string, number>;
  cleared?: OpenChoiceVerdict;
}

// Workspaces --------------------------------------------------------------------------------------

/** The workspaces under the repository root, read from each folder's `package.json`. */
export function loadWorkspaces(root = process.cwd()): Workspace[] {
  const found: Workspace[] = [];
  for (const top of workspaceRoots) {
    const folder = join(root, top);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      const manifest = join(folder, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { description?: unknown };
      const about = typeof parsed.description === 'string' ? parsed.description.trim() : '';
      found.push({ name, path: `${top}/${name}`, about: about === '' ? `${top}/${name}` : about });
    }
  }
  return found;
}

// Questions ---------------------------------------------------------------------------------------

/** The text Jev reads: the issue as a person reads it, without HTML comments or shared programme text. */
export function issueState(issue: Pick<GroomIssue, 'title' | 'description'>): string {
  const body = stripShared((issue.description ?? '').replace(/<!--[\s\S]*?-->/g, '')).text.trim();
  return `# ${issue.title}\n\n${body === '' ? '(The issue has no description.)' : body}`;
}

const labelNames = (issue: GroomIssue) => issue.labels.nodes.map((label) => label.name);

/** The package labels that name a workspace in this repository, and that the issue lacks. */
function candidatePackages(issue: GroomIssue, workspaces: Workspace[]): Workspace[] {
  const held = new Set(labelNames(issue).map((name) => name.toLowerCase()));
  return workspaces.filter((workspace) => !held.has(`${PACKAGE_PREFIX}${workspace.name}`));
}

/** A short hash of the text Jev reads, so a later run can tell whether that text changed. */
export function textHash(issue: Pick<GroomIssue, 'title' | 'description'>): string {
  return new Bun.CryptoHasher('sha256').update(issueState(issue)).digest('hex').slice(0, 16);
}

/** The readiness questions that apply: each one whose section exists, or that judges no section. */
export function applicableReadiness(issue: Pick<GroomIssue, 'description'>): string[] {
  const sections = parseSections(issue.description ?? '');
  return readinessQuestions
    .filter(
      (readiness) =>
        readiness.section === undefined || (sections.get(readiness.section) ?? '') !== '',
    )
    .map((readiness) => readiness.name);
}

/**
 * One batch for one issue: priority and Work Type only when missing, every candidate package, and
 * every applicable readiness question that `reused` does not already answer.
 */
export function buildBatch(
  issue: GroomIssue,
  workspaces: Workspace[],
  reused: ReadonlyMap<string, number> = new Map(),
): DecisionBatch {
  const questions = new Map<string, DecisionQuestion>();
  if (issue.priority === 0) questions.set('priority', priorityQuestion);
  if (!labelNames(issue).some((name) => name.startsWith(WORK_TYPE_PREFIX)))
    questions.set('work-type', workTypeQuestion);
  for (const workspace of candidatePackages(issue, workspaces))
    questions.set(
      `${PACKAGE_PREFIX}${workspace.name}`,
      packageQuestion(workspace.path, workspace.about),
    );
  const applicable = new Set(applicableReadiness(issue));
  for (const readiness of readinessQuestions)
    if (applicable.has(readiness.name) && !reused.has(readiness.name))
      questions.set(readiness.name, readiness.question);
  return { context: issueState(issue), questions };
}

// Answers -----------------------------------------------------------------------------------------

/** The probability that a yes/no answer is yes; Jev's probability is that of its own value. */
export function probabilityOfYes(decision: Decision<unknown> | undefined): number | undefined {
  if (decision === undefined || typeof decision.value !== 'boolean') return undefined;
  if (decision.probability === undefined) return undefined;
  return decision.value ? decision.probability : 1 - decision.probability;
}

type Reading = 'yes' | 'no' | 'unsettled';

export function read(probability: number | undefined): Reading {
  if (probability === undefined) return 'unsettled';
  if (probability > yesThreshold) return 'yes';
  if (probability < noThreshold) return 'no';
  return 'unsettled';
}

function answer(result: DecisionBatchResult, name: string): Decision<unknown> {
  const decision = result.decisions.get(name);
  if (decision === undefined) throw new JevError(`Jev returned no answer to "${name}".`);
  return decision;
}

/** What Jev said, for the report: the probability of yes, or the chosen value. */
function answersOf(result: DecisionBatchResult): Record<string, number | string | boolean> {
  const answers: Record<string, number | string | boolean> = {};
  for (const [name, decision] of result.decisions) {
    const yes = probabilityOfYes(decision);
    answers[name] =
      yes === undefined
        ? (decision.value as number | string | boolean)
        : Math.round(yes * 100) / 100;
  }
  return answers;
}

/** Jev failed or answered something unusable. */
export class JevError extends Error {}

export interface Plan {
  priority?: PriorityName;
  labels: string[];
  labelsUnsettled: string[];
  findings: GroomFinding[];
}

/**
 * Turn Jev's answers and the mechanical checks into what to write and what fails. `readiness` holds
 * each applicable readiness question's probability of yes, asked this run or reused from the last
 * one; `cleared` passes an unsettled open-choice reading, never a clear one.
 */
export function plan(
  issue: GroomIssue,
  result: DecisionBatchResult,
  mechanical: GroomFinding[],
  readiness: ReadonlyMap<string, number | undefined>,
  cleared = false,
): Plan {
  const decided: Plan = { labels: [], labelsUnsettled: [], findings: [...mechanical] };
  if (result.decisions.has('priority')) {
    const index = answer(result, 'priority').value;
    if (typeof index !== 'number' || priorityOrder[index] === undefined)
      throw new JevError('Jev returned no usable priority.');
    decided.priority = priorityOrder[index];
  }
  if (result.decisions.has('work-type')) {
    const key = answer(result, 'work-type').value;
    if (typeof key !== 'string' || !workTypeOptions.some((option) => option.key === key))
      throw new JevError('Jev named no Work Type that was offered.');
    decided.labels.push(key);
  }
  for (const [name, decision] of result.decisions) {
    if (!name.startsWith(PACKAGE_PREFIX)) continue;
    const reading = read(probabilityOfYes(decision));
    if (reading === 'yes') decided.labels.push(name);
    else if (reading === 'unsettled') decided.labelsUnsettled.push(name);
  }
  const workTypes = [...labelNames(issue), ...decided.labels].filter((name) =>
    name.startsWith(WORK_TYPE_PREFIX),
  );
  if (workTypes.length !== 1)
    decided.findings.push({
      code: 'work-type-count',
      message: `The issue carries ${workTypes.length} Work Type labels (${workTypes.join(', ')}); it needs exactly one.`,
      need: 'rewrite',
    });
  for (const question of readinessQuestions) {
    // A question not asked judged a missing section, which a mechanical finding already fails.
    if (!readiness.has(question.name)) continue;
    const reading = read(readiness.get(question.name));
    if (reading === question.passWhen) continue;
    if (question.name === OPEN_CHOICE && reading === 'unsettled' && cleared) continue;
    decided.findings.push({
      code: reading === 'unsettled' ? `${question.name}-unsettled` : question.name,
      message:
        reading === 'unsettled'
          ? `${question.failure} (Jev could not settle this from the issue as written.)`
          : question.failure,
      // An unmade choice is the owner's to make; every other judgment failure a rewrite can fix.
      need: question.name === OPEN_CHOICE ? 'owner' : 'rewrite',
    });
  }
  return decided;
}

/** Each readiness probability of yes Jev gave this run. */
function readinessAnswers(result: DecisionBatchResult): Map<string, number | undefined> {
  const readings = new Map<string, number | undefined>();
  for (const question of readinessQuestions)
    if (result.decisions.has(question.name))
      readings.set(question.name, probabilityOfYes(answer(result, question.name)));
  return readings;
}

/** Mechanical findings: the triage checks that block, and every open blocker. */
export function mechanicalFindings(
  issue: GroomIssue,
  blockers: Blocker[],
  repository: () => RepositoryView,
): GroomFinding[] {
  const owner = new Set(['unanswered-marker', 'unanswered-question', 'open-questions']);
  const description = issue.description ?? '';
  const triage = [
    ...readyFindings(issue.description),
    ...(citationsIn(description).length === 0 ? [] : citationFindings(description, repository())),
  ].filter(isBlocking);
  return [
    ...(issue.team.key === TEAM
      ? []
      : [
          {
            code: 'team',
            message: `The issue is in ${issue.team.key}, not ${TEAM}.`,
            need: 'owner' as const,
          },
        ]),
    ...triage.map((finding) => ({
      code: finding.code,
      message: finding.message,
      need: owner.has(finding.code) ? ('owner' as const) : ('rewrite' as const),
    })),
    ...blockers.map((blocker) => ({
      code: 'open-blocker',
      message: `Blocked by ${blocker.identifier} [${blocker.state}]: ${blocker.title}.`,
      need: (blocker.stateType === 'canceled' ? 'owner' : 'wait') as Need,
    })),
  ];
}

// The comment -------------------------------------------------------------------------------------

const recordPrefix = 'Groom record:';
const verdictPattern = /^No owner choice \(groom review, (\d{4}-\d{2}-\d{2})\): (.+)$/m;

/** The record line and any verdict line that end the comment. */
function recordLines(record: GroomRecord): string[] {
  const readings = [...record.readings].map(([name, value]) => `${name}=${value.toFixed(2)}`);
  const tokens = [
    `text=${record.text}`,
    ...readings,
    ...(record.cleared ? ['cleared=no-open-choice'] : []),
  ];
  return [
    '',
    ...(record.cleared
      ? [`No owner choice (groom review, ${record.cleared.date}): ${record.cleared.reason}`]
      : []),
    `${recordPrefix} \`${tokens.join(' ')}\``,
  ];
}

/** The record a comment ends with, or nothing when it has none this groomer can read. */
export function parseRecord(body: string): GroomRecord | undefined {
  const line = body.split('\n').find((candidate) => candidate.startsWith(recordPrefix));
  const span = line === undefined ? undefined : /`([^`]*)`/.exec(line)?.[1];
  if (span === undefined) return undefined;
  const known = new Set(readinessQuestions.map((question) => question.name));
  const readings = new Map<string, number>();
  let text: string | undefined;
  let cleared = false;
  for (const token of span.split(/\s+/)) {
    const [name = '', value = ''] = token.split('=');
    if (name === 'text' && /^[0-9a-f]{16}$/.test(value)) text = value;
    else if (name === 'cleared') cleared = value === OPEN_CHOICE;
    else if (known.has(name) && /^(0(\.\d+)?|1(\.0+)?)$/.test(value))
      readings.set(name, Number(value));
  }
  if (text === undefined) return undefined;
  const verdict = verdictPattern.exec(body);
  return {
    text,
    readings,
    ...(cleared && verdict?.[1] !== undefined && verdict[2] !== undefined
      ? { cleared: { date: verdict[1], reason: verdict[2].trim() } }
      : {}),
  };
}

export function groomComment(
  report: Pick<GroomReport, 'ready' | 'findings'>,
  record?: GroomRecord,
): string {
  const summary = report.ready
    ? [
        `${commentMarker} Ready. Every Definition of Ready predicate passed (references/linear-policy.md).`,
      ]
    : [
        `${commentMarker} not Ready. These Definition of Ready predicates fail (references/linear-policy.md):`,
        '',
        ...report.findings.map(
          (finding) =>
            `- ${finding.message}${finding.need === 'owner' ? ' (needs an answer from the owner)' : ''}`,
        ),
      ];
  return [...summary, ...(record === undefined ? [] : recordLines(record))].join('\n');
}

interface OwnComment {
  id: string;
  body: string;
}

/** The groomer's own comment on the issue, the last one that starts with its marker. */
async function ownComment(
  client: LinearClient,
  identifier: string,
): Promise<OwnComment | undefined> {
  const comments = await fetchComments(client, identifier);
  return comments.findLast((comment) => comment.body.startsWith(commentMarker));
}

/** Replace this groomer's comment on the issue, or post one when there is none it can edit. */
async function upsertComment(
  client: LinearClient,
  identifier: string,
  own: OwnComment | undefined,
  body: string,
): Promise<Outcome> {
  if (own !== undefined) {
    if (own.body.trim() === body.trim())
      return { ok: true, summary: 'unchanged', data: { unchanged: true } };
    const updated = await updateComment(client, identifier, own.id, body);
    if (updated.ok || updated.data['reason'] === undefined) return updated;
  }
  return postComment(client, identifier, body);
}

// Linear reads ------------------------------------------------------------------------------------

const issueFields =
  'id identifier title description priority state { name } team { id key parent { id } } labels(first: 50) { nodes { name } }';

async function fetchGroomIssue(client: LinearClient, identifier: string): Promise<GroomIssue> {
  const data = await client.request<{ issue: GroomIssue | null }>(
    `query GroomIssue($id: String!) { issue(id: $id) { ${issueFields} } }`,
    { id: identifier },
  );
  if (data.issue === null) throw new UsageError(`No issue ${identifier}.`);
  return data.issue;
}

async function listBacklog(client: LinearClient, limit: number): Promise<GroomIssue[]> {
  const filter = { team: { key: { eq: TEAM } }, state: { name: { eq: BACKLOG } } };
  const issues: GroomIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const data: {
      issues: { nodes: GroomIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } = await client.request(
      `query GroomBacklog($filter: IssueFilter, $after: String) { issues(first: 50, after: $after, filter: $filter, orderBy: createdAt) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`,
      { filter, after },
    );
    issues.push(...data.issues.nodes);
    if (issues.length >= limit || !data.issues.pageInfo.hasNextPage) return issues.slice(0, limit);
    after = data.issues.pageInfo.endCursor;
  }
  throw new LinearError(`More than ${PAGE_LIMIT * 50} Backlog issues; refusing a partial list.`);
}

// One issue ---------------------------------------------------------------------------------------

interface Context {
  client: LinearClient;
  decide: Decide;
  repository: () => RepositoryView;
  workspaces: Workspace[];
  dryRun: boolean;
}

async function write(
  context: Context,
  writes: string[],
  label: string,
  action: () => Promise<Outcome>,
) {
  writes.push(label);
  if (context.dryRun) return;
  const outcome = await action();
  if (!outcome.ok) throw new LinearError(outcome.summary);
}

async function ask(context: Context, issue: GroomIssue, batch: DecisionBatch) {
  // Nothing left to ask (every readiness reading reused, priority and labels set): no call.
  if (batch.questions.size === 0) return { decisions: new Map() } satisfies DecisionBatchResult;
  try {
    return await context.decide(batch);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new JevError(
      `Jev failed on ${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Groom one issue. `verdict` is the groom skill's `--clear-open-choice` verdict; it is refused
 * unless the open-choice reading for the current text is unsettled.
 */
export async function groomIssue(
  context: Context,
  issue: GroomIssue,
  verdict?: OpenChoiceVerdict,
): Promise<GroomReport> {
  const own = await ownComment(context.client, issue.identifier);
  const text = textHash(issue);
  const last = own === undefined ? undefined : parseRecord(own.body);
  // A record of other words is stale: the text changed, so every judgment is asked again.
  const prior = last?.text === text ? last : undefined;
  const applicable = applicableReadiness(issue);
  const reused = new Map(
    applicable.flatMap((name) => {
      const value = prior?.readings.get(name);
      return value === undefined ? [] : [[name, value] as const];
    }),
  );
  const result = await ask(context, issue, buildBatch(issue, context.workspaces, reused));
  const readiness = new Map<string, number | undefined>([...reused, ...readinessAnswers(result)]);
  if (verdict !== undefined) {
    const value = readiness.get(OPEN_CHOICE);
    if (value === undefined || read(value) !== 'unsettled')
      throw new UsageError(
        `${issue.identifier}: the open-choice reading is ${value === undefined ? 'missing' : value.toFixed(2)}; only a reading between ${noThreshold} and ${yesThreshold} can be cleared, and a clear yes goes to the owner.`,
      );
  }
  const cleared = verdict ?? prior?.cleared;
  const blockers = await openBlockers(context.client, issue.identifier);
  const decided = plan(
    issue,
    result,
    mechanicalFindings(issue, blockers, context.repository),
    readiness,
    cleared !== undefined,
  );
  const ready = decided.findings.length === 0;
  const answers = answersOf(result);
  for (const [name, value] of reused) answers[name] = value;
  // A verdict is kept only while the reading it cleared is still unsettled for these words.
  const holds = cleared !== undefined && read(readiness.get(OPEN_CHOICE)) === 'unsettled';
  const report: GroomReport = {
    identifier: issue.identifier,
    title: issue.title,
    ...(decided.priority === undefined ? {} : { priority: decided.priority }),
    labelsAdded: decided.labels,
    labelsUnsettled: decided.labelsUnsettled,
    answers,
    reused: [...reused.keys()],
    ...(holds ? { cleared } : {}),
    ready,
    findings: decided.findings,
    writes: [],
  };
  const record: GroomRecord = {
    text,
    readings: new Map(
      [...readiness].flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Math.round(value * 100) / 100] as const],
      ),
    ),
    ...(holds ? { cleared } : {}),
  };
  const { priority } = decided;
  if (priority !== undefined)
    await write(context, report.writes, `priority ${priority}`, () =>
      setPriority(context.client, issue.identifier, priority),
    );
  if (decided.labels.length > 0)
    await write(context, report.writes, `labels ${decided.labels.join(', ')}`, () =>
      addLabels(context.client, issue.identifier, decided.labels),
    );
  await write(context, report.writes, ready ? 'comment Ready' : 'comment not Ready', () =>
    upsertComment(context.client, issue.identifier, own, groomComment(report, record)),
  );
  // Only a Backlog issue is promoted: a named issue already in progress keeps its state.
  if (ready && issue.state.name === BACKLOG)
    await write(context, report.writes, `state ${READY}`, () =>
      setState(context.client, issue.identifier, READY),
    );
  return report;
}

// Command line ------------------------------------------------------------------------------------

interface Options {
  identifiers: string[];
  limit: number;
  dryRun: boolean;
  json: boolean;
  /** `--clear-open-choice`: the one issue named, with the reason the groom skill found. */
  clear?: { identifier: string; reason: string };
}

function identifierOf(flag: string, value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value))
    throw new UsageError(`${flag} needs an identifier such as COR-12, not "${value}".`);
  return value.toUpperCase();
}

function parseArguments(argv: string[]): Options {
  const parsed = parseOptions(argv, {
    values: ['limit', 'clear-open-choice', 'reason'],
    repeated: ['issue'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const identifiers = (parsed.repeated['issue'] ?? []).map((value) =>
    identifierOf('--issue', value),
  );
  const limit = parsed.values['limit'];
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit))
    throw new UsageError('--limit needs a positive integer.');
  const clearing = parsed.values['clear-open-choice'];
  const reason = parsed.values['reason']?.replace(/\s+/g, ' ').trim();
  if ((clearing === undefined) !== (reason === undefined))
    throw new UsageError('--clear-open-choice and --reason go together.');
  if (reason === '') throw new UsageError('--reason needs the reason no owner choice remains.');
  if (clearing !== undefined && (identifiers.length > 0 || limit !== undefined))
    throw new UsageError(
      '--clear-open-choice names its one issue; it takes no --issue or --limit.',
    );
  return {
    identifiers,
    limit: limit === undefined ? Number.POSITIVE_INFINITY : Number(limit),
    dryRun: parsed.flags.has('dry-run'),
    json: parsed.flags.has('json'),
    ...(clearing === undefined || reason === undefined
      ? {}
      : { clear: { identifier: identifierOf('--clear-open-choice', clearing), reason } }),
  };
}

/** Jev through the repository's adapter, with the key from credentials.ts. */
async function defaultDecide(): Promise<Decide> {
  const apiKey = resolveCredential('TYPESAFE_API_KEY').value;
  if (apiKey === undefined || apiKey === '')
    throw new UsageError(
      'TYPESAFE_API_KEY is unavailable: it is not in the environment, the macOS Keychain (service typesafe-api) or a .env file; see credentials.ts.',
    );
  const { TYPESAFE_JEV_MODEL, typesafeProvider } = await import('@lostgradient/operative-typesafe');
  const model = typesafeProvider.decide({
    provider: typesafeProvider.name,
    model: TYPESAFE_JEV_MODEL,
    apiKey,
  });
  if (model.decideBatch === undefined)
    throw new JevError('The Jev adapter has no batch decisions.');
  return async (batch) => {
    if (model.decideBatch === undefined)
      throw new JevError('The Jev adapter has no batch decisions.');
    return model.decideBatch(batch);
  };
}

function render(report: GroomReport): string[] {
  const head = `${report.identifier} ${report.ready ? 'Ready' : 'Backlog'}${report.writes.length > 0 ? ` [${report.writes.join('; ')}]` : ''} ${report.title}`;
  return [
    head,
    ...report.findings.map(
      (finding) => `  - ${finding.code} (${finding.need}): ${finding.message}`,
    ),
    ...(report.labelsUnsettled.length > 0
      ? [`  · unsettled labels: ${report.labelsUnsettled.join(', ')}`]
      : []),
  ];
}

export async function run(
  argv: string[],
  dependencies: GroomDependencies = {},
): Promise<{ code: number; output: string }> {
  const options = parseArguments(argv);
  const client = createClient(dependencies);
  const failure = (message: string) => ({
    code: 3,
    output: options.json ? JSON.stringify({ ok: false, error: message }) : message,
  });
  const reports: GroomReport[] = [];
  try {
    const context: Context = {
      client,
      decide: dependencies.decide ?? (await defaultDecide()),
      repository: (() => {
        let view: RepositoryView | undefined;
        return () => (view ??= (dependencies.repository ?? loadRepository)());
      })(),
      workspaces: (dependencies.workspaces ?? loadWorkspaces)(),
      dryRun: options.dryRun,
    };
    const named = options.clear === undefined ? options.identifiers : [options.clear.identifier];
    const issues =
      named.length > 0
        ? await Promise.all(named.map((id) => fetchGroomIssue(client, id)))
        : await listBacklog(client, options.limit);
    const verdict =
      options.clear === undefined
        ? undefined
        : {
            date: (dependencies.today ?? (() => new Date().toISOString().slice(0, 10)))(),
            reason: options.clear.reason,
          };
    const first = issues[0];
    if (first !== undefined) {
      // Offer only the package labels Linear has, so every label Jev picks can be applied.
      const labels = await teamLabels(client, first.team);
      const held = new Set(labels.map((label) => label.name.toLowerCase()));
      context.workspaces = context.workspaces.filter((workspace) =>
        held.has(`${PACKAGE_PREFIX}${workspace.name}`.toLowerCase()),
      );
    }
    for (const issue of issues) reports.push(await groomIssue(context, issue, verdict));
  } catch (error) {
    if (error instanceof LinearError) return failure(`Linear is unavailable: ${error.message}`);
    if (error instanceof JevError) return failure(error.message);
    throw error;
  }
  const waiting = reports.filter((report) => !report.ready);
  const code = waiting.length === 0 ? 0 : 1;
  if (options.json)
    return {
      code,
      output: JSON.stringify({ ok: code === 0, dryRun: options.dryRun, issues: reports }),
    };
  const head = `groom${options.dryRun ? ' (dry run)' : ''}: ${reports.length} issue${reports.length === 1 ? '' : 's'}, ${reports.length - waiting.length} Ready, ${waiting.length} still in Backlog.`;
  return { code, output: [head, ...reports.flatMap(render)].join('\n') };
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
