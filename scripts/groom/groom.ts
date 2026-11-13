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
// Usage (LINEAR_API_KEY and TYPESAFE_API_KEY resolve through credentials.ts; neither is printed):
//   bun scripts/groom/groom.ts [--issue COR-n ...] [--limit n] [--dry-run] [--json]
//
// `--dry-run` asks Jev and reports what it would write, writing nothing.
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

/** One batch for one issue: priority and Work Type only when missing, every candidate package, every readiness question. */
export function buildBatch(issue: GroomIssue, workspaces: Workspace[]): DecisionBatch {
  const questions = new Map<string, DecisionQuestion>();
  if (issue.priority === 0) questions.set('priority', priorityQuestion);
  if (!labelNames(issue).some((name) => name.startsWith(WORK_TYPE_PREFIX)))
    questions.set('work-type', workTypeQuestion);
  for (const workspace of candidatePackages(issue, workspaces))
    questions.set(
      `${PACKAGE_PREFIX}${workspace.name}`,
      packageQuestion(workspace.path, workspace.about),
    );
  const sections = parseSections(issue.description ?? '');
  for (const readiness of readinessQuestions)
    if (readiness.section === undefined || (sections.get(readiness.section) ?? '') !== '')
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

/** Turn Jev's answers and the mechanical checks into what to write and what fails. */
export function plan(
  issue: GroomIssue,
  result: DecisionBatchResult,
  mechanical: GroomFinding[],
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
  for (const readiness of readinessQuestions) {
    // A question not asked judged a missing section, which a mechanical finding already fails.
    if (!result.decisions.has(readiness.name)) continue;
    const reading = read(probabilityOfYes(answer(result, readiness.name)));
    if (reading === readiness.passWhen) continue;
    decided.findings.push({
      code: reading === 'unsettled' ? `${readiness.name}-unsettled` : readiness.name,
      message:
        reading === 'unsettled'
          ? `${readiness.failure} (Jev could not settle this from the issue as written.)`
          : readiness.failure,
      // An unmade choice is the owner's to make; every other judgment failure a rewrite can fix.
      need: readiness.name === 'no-open-choice' ? 'owner' : 'rewrite',
    });
  }
  return decided;
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

export function groomComment(report: Pick<GroomReport, 'ready' | 'findings'>): string {
  if (report.ready)
    return `${commentMarker} Ready. Every Definition of Ready predicate passed (references/linear-policy.md).`;
  return [
    `${commentMarker} not Ready. These Definition of Ready predicates fail (references/linear-policy.md):`,
    '',
    ...report.findings.map(
      (finding) =>
        `- ${finding.message}${finding.need === 'owner' ? ' (needs an answer from the owner)' : ''}`,
    ),
  ].join('\n');
}

/** Replace this groomer's comment on the issue, or post one when there is none it can edit. */
async function upsertComment(
  client: LinearClient,
  identifier: string,
  body: string,
): Promise<Outcome> {
  const comments = await fetchComments(client, identifier);
  const own = comments.findLast((comment) => comment.body.startsWith(commentMarker));
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

export async function groomIssue(context: Context, issue: GroomIssue): Promise<GroomReport> {
  const batch = buildBatch(issue, context.workspaces);
  let result: DecisionBatchResult;
  try {
    result = await context.decide(batch);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new JevError(
      `Jev failed on ${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const blockers = await openBlockers(context.client, issue.identifier);
  const decided = plan(issue, result, mechanicalFindings(issue, blockers, context.repository));
  const ready = decided.findings.length === 0;
  const report: GroomReport = {
    identifier: issue.identifier,
    title: issue.title,
    ...(decided.priority === undefined ? {} : { priority: decided.priority }),
    labelsAdded: decided.labels,
    labelsUnsettled: decided.labelsUnsettled,
    answers: answersOf(result),
    ready,
    findings: decided.findings,
    writes: [],
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
    upsertComment(context.client, issue.identifier, groomComment(report)),
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
}

function parseArguments(argv: string[]): Options {
  const parsed = parseOptions(argv, {
    values: ['limit'],
    repeated: ['issue'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const identifiers = (parsed.repeated['issue'] ?? []).map((value) => {
    if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value))
      throw new UsageError(`--issue needs an identifier such as COR-12, not "${value}".`);
    return value.toUpperCase();
  });
  const limit = parsed.values['limit'];
  if (limit !== undefined && !/^[1-9]\d*$/.test(limit))
    throw new UsageError('--limit needs a positive integer.');
  return {
    identifiers,
    limit: limit === undefined ? Number.POSITIVE_INFINITY : Number(limit),
    dryRun: parsed.flags.has('dry-run'),
    json: parsed.flags.has('json'),
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
    const issues =
      options.identifiers.length > 0
        ? await Promise.all(options.identifiers.map((id) => fetchGroomIssue(client, id)))
        : await listBacklog(client, options.limit);
    const first = issues[0];
    if (first !== undefined) {
      // Offer only the package labels Linear has, so every label Jev picks can be applied.
      const labels = await teamLabels(client, first.team);
      const held = new Set(labels.map((label) => label.name.toLowerCase()));
      context.workspaces = context.workspaces.filter((workspace) =>
        held.has(`${PACKAGE_PREFIX}${workspace.name}`.toLowerCase()),
      );
    }
    for (const issue of issues) reports.push(await groomIssue(context, issue));
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
