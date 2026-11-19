#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { parseJUnit } from './evidence-provider.ts';

export class CiEvidenceWorkflowError extends Error {}

export interface CiEvidenceWorkflowEnvironment {
  GITHUB_REPOSITORY?: string | undefined;
  GITHUB_EVENT_NAME?: string | undefined;
  GITHUB_EVENT_PATH?: string | undefined;
  GITHUB_WORKFLOW_REF?: string | undefined;
  GITHUB_WORKFLOW_SHA?: string | undefined;
  GITHUB_RUN_ID?: string | undefined;
  GITHUB_RUN_ATTEMPT?: string | undefined;
  VERIFICATION_REQUEST?: string | undefined;
  VERIFICATION_PLAN?: string | undefined;
  VERIFICATION_BASE?: string | undefined;
  CI_EVIDENCE_NEEDS?: string | undefined;
  CI_EVIDENCE_NOT_APPLICABLE?: string | undefined;
  CI_EVIDENCE_ARTIFACT_DIRECTORY?: string | undefined;
}

interface GitResult {
  code: number;
  stdout: string;
}

export interface CiEvidenceWorkflowReceipt {
  repository: string;
  event: 'pull_request' | 'workflow_dispatch' | 'push';
  workflowPath: string;
  workflowRevision: string;
  requestKey: string;
  planDigest: string;
  base: string;
  candidate: string;
  checkedRevision: string;
  checkedTree: string;
  runId: number;
  attempt: number;
  jobs: Record<string, 'success' | 'not-applicable'>;
  reports?: Record<string, { reports: number; testCases: number }>;
}

const commit = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
const repository = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredCommit(value: unknown, label: string): string {
  if (!commit(value))
    throw new CiEvidenceWorkflowError(`${label} must be a 40-character commit SHA`);
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (!digest(value)) throw new CiEvidenceWorkflowError(`${label} must be a SHA-256 digest`);
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new CiEvidenceWorkflowError(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new CiEvidenceWorkflowError(`${label} is outside safe range`);
  return parsed;
}

function readWorkflowReference(environment: CiEvidenceWorkflowEnvironment): {
  workflowPath: string;
  workflowRevision: string;
} {
  const value = environment.GITHUB_WORKFLOW_REF;
  const match =
    value === undefined
      ? undefined
      : /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([0-9a-f]{40})$/i.exec(
          value,
        );
  if (match === undefined || match === null || !repository(environment.GITHUB_REPOSITORY))
    throw new CiEvidenceWorkflowError('GITHUB_WORKFLOW_REF is not a trusted workflow reference');
  if (match[1] !== environment.GITHUB_REPOSITORY)
    throw new CiEvidenceWorkflowError(
      'workflow reference repository does not match GITHUB_REPOSITORY',
    );
  const workflowRevision = requiredCommit(environment.GITHUB_WORKFLOW_SHA, 'GITHUB_WORKFLOW_SHA');
  if (match[3] !== workflowRevision)
    throw new CiEvidenceWorkflowError(
      'workflow reference revision does not match GITHUB_WORKFLOW_SHA',
    );
  return { workflowPath: match[2]!, workflowRevision };
}

function checkedCommit(
  runner: (command: readonly string[]) => GitResult,
  revision: string,
): string {
  const result = runner(['git', 'rev-parse', revision]);
  if (result.code !== 0) throw new CiEvidenceWorkflowError(`git could not resolve ${revision}`);
  return requiredCommit(result.stdout.trim(), `git ${revision}`);
}

function notApplicableJobs(value: string | undefined): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '[]');
  } catch {
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_NOT_APPLICABLE is not valid JSON');
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name))
  )
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_NOT_APPLICABLE must be a job-name array');
  return new Set(parsed);
}

function needsInventory(
  value: string | undefined,
  notApplicable: ReadonlySet<string>,
): Record<string, 'success' | 'not-applicable'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_NEEDS is not valid JSON');
  }
  const entries = record(parsed);
  if (entries === undefined || Object.keys(entries).length === 0)
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_NEEDS has no prerequisite jobs');
  const inventory: Record<string, 'success' | 'not-applicable'> = {};
  for (const [name, detail] of Object.entries(entries)) {
    const result = record(detail)?.['result'];
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new CiEvidenceWorkflowError(`prerequisite ${name} has an invalid job name`);
    if (result === 'success') inventory[name] = 'success';
    else if (result === 'skipped' && notApplicable.has(name)) inventory[name] = 'not-applicable';
    else throw new CiEvidenceWorkflowError(`prerequisite ${name} did not succeed`);
  }
  for (const name of notApplicable)
    if (!(name in inventory))
      throw new CiEvidenceWorkflowError(`not-applicable job ${name} is absent`);
  return inventory;
}

function derivedPlanDigest(input: {
  event: string;
  workflowPath: string;
  workflowRevision: string;
  jobs: Record<string, 'success' | 'not-applicable'>;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        event: input.event,
        workflowPath: input.workflowPath,
        workflowRevision: input.workflowRevision,
        jobs: Object.keys(input.jobs).toSorted(),
      }),
    )
    .digest('hex');
}

function derivedRequestKey(input: {
  repository: string;
  base: string;
  candidate: string;
  planDigest: string;
  workflowRevision: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function payloadCommit(payload: unknown, side: 'base' | 'head'): string {
  const pullRequest = record(record(payload)?.['pull_request']);
  const sha = record(pullRequest?.[side])?.['sha'];
  if (!commit(sha))
    throw new CiEvidenceWorkflowError(`pull_request event payload has no valid ${side} SHA`);
  return sha;
}

function pushCommit(payload: unknown, field: 'before' | 'after'): string {
  const sha = record(payload)?.[field];
  if (!commit(sha))
    throw new CiEvidenceWorkflowError(`push event payload has no valid ${field} SHA`);
  return sha;
}

/** Parse every required artifact bundle independently, so a partial report set is never aggregate success. */
export function validateJUnitArtifacts(
  artifacts: Readonly<Record<string, readonly Uint8Array[]>>,
  expected: readonly string[],
): Record<string, { reports: number; testCases: number }> {
  const summaries: Record<string, { reports: number; testCases: number }> = {};
  for (const name of expected) {
    const reports = artifacts[name];
    if (reports === undefined)
      throw new CiEvidenceWorkflowError(`required JUnit artifact ${name} is missing`);
    if (reports.length === 0)
      throw new CiEvidenceWorkflowError(`required JUnit artifact ${name} has no reports`);
    let testCases = 0;
    for (const report of reports) {
      let parsed: { inventory: string[]; assertionPassed: boolean };
      try {
        parsed = parseJUnit(report);
      } catch {
        throw new CiEvidenceWorkflowError(`required JUnit artifact ${name} has malformed XML`);
      }
      if (parsed.inventory.length === 0)
        throw new CiEvidenceWorkflowError(`required JUnit artifact ${name} has an empty report`);
      if (!parsed.assertionPassed)
        throw new CiEvidenceWorkflowError(
          `required JUnit artifact ${name} contains a failed assertion`,
        );
      testCases += parsed.inventory.length;
    }
    summaries[name] = { reports: reports.length, testCases };
  }
  return summaries;
}

function reportFiles(directory: string): Uint8Array[] {
  const files: Uint8Array[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      const status = lstatSync(child);
      if (status.isSymbolicLink())
        throw new CiEvidenceWorkflowError('JUnit artifact contains a symbolic link');
      if (status.isDirectory()) visit(child);
      else if (status.isFile() && entry.name.endsWith('.xml')) files.push(readFileSync(child));
    }
  };
  try {
    visit(directory);
  } catch (error) {
    if (error instanceof CiEvidenceWorkflowError) throw error;
    throw new CiEvidenceWorkflowError(
      `required JUnit artifact directory ${directory} is unreadable`,
    );
  }
  return files;
}

function expectedArtifacts(attempt: number): string[] {
  return [
    `junit-root-${attempt}`,
    ...Array.from({ length: 7 }, (_, index) => `junit-tests-${index}-${attempt}`),
  ];
}

function downloadedJUnitArtifacts(
  directory: string,
  attempt: number,
): Record<string, Uint8Array[]> {
  return Object.fromEntries(
    expectedArtifacts(attempt).map((name) => [name, reportFiles(`${directory}/${name}`)]),
  );
}

export function createCiEvidenceWorkflowReceipt(input: {
  environment: CiEvidenceWorkflowEnvironment;
  eventPayload: unknown;
  git: (command: readonly string[]) => GitResult;
}): CiEvidenceWorkflowReceipt {
  const { environment } = input;
  if (!repository(environment.GITHUB_REPOSITORY))
    throw new CiEvidenceWorkflowError('GITHUB_REPOSITORY is invalid');
  const event = environment.GITHUB_EVENT_NAME;
  if (event !== 'pull_request' && event !== 'workflow_dispatch' && event !== 'push')
    throw new CiEvidenceWorkflowError('unsupported GitHub event');
  const { workflowPath, workflowRevision } = readWorkflowReference(environment);
  const checkedRevision = checkedCommit(input.git, 'HEAD');
  const checkedTree = checkedCommit(input.git, 'HEAD^{tree}');
  const jobs = needsInventory(
    environment.CI_EVIDENCE_NEEDS,
    notApplicableJobs(environment.CI_EVIDENCE_NOT_APPLICABLE),
  );
  const base =
    event === 'pull_request'
      ? payloadCommit(input.eventPayload, 'base')
      : event === 'push'
        ? pushCommit(input.eventPayload, 'before')
        : requiredCommit(environment.VERIFICATION_BASE, 'VERIFICATION_BASE');
  const candidate =
    event === 'pull_request'
      ? payloadCommit(input.eventPayload, 'head')
      : event === 'push'
        ? pushCommit(input.eventPayload, 'after')
        : checkedRevision;
  const planDigest =
    event === 'workflow_dispatch'
      ? requiredDigest(environment.VERIFICATION_PLAN, 'VERIFICATION_PLAN')
      : derivedPlanDigest({ event, workflowPath, workflowRevision, jobs });
  const requestKey =
    event === 'workflow_dispatch'
      ? requiredDigest(environment.VERIFICATION_REQUEST, 'VERIFICATION_REQUEST')
      : derivedRequestKey({
          repository: environment.GITHUB_REPOSITORY,
          base,
          candidate,
          planDigest,
          workflowRevision,
        });
  const attempt = requiredPositiveInteger(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  const reportDirectory = environment.CI_EVIDENCE_ARTIFACT_DIRECTORY;
  return {
    repository: environment.GITHUB_REPOSITORY,
    event,
    workflowPath,
    workflowRevision,
    requestKey,
    planDigest,
    base,
    candidate,
    checkedRevision,
    checkedTree,
    runId: requiredPositiveInteger(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    attempt,
    jobs,
    ...(reportDirectory === undefined
      ? {}
      : {
          reports: validateJUnitArtifacts(
            downloadedJUnitArtifacts(reportDirectory, attempt),
            expectedArtifacts(attempt),
          ),
        }),
  };
}

function readEventPayload(path: string | undefined): unknown {
  if (path === undefined || path === '')
    throw new CiEvidenceWorkflowError('GITHUB_EVENT_PATH is required');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CiEvidenceWorkflowError('GITHUB_EVENT_PATH is unreadable or malformed');
  }
}

function git(command: readonly string[]): GitResult {
  const result = Bun.spawnSync([...command], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
}

export function writeCiEvidenceWorkflowReceipt(
  path: string,
  receipt: CiEvidenceWorkflowReceipt,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  const output = process.argv[2] ?? 'ci-evidence-receipt.json';
  try {
    writeCiEvidenceWorkflowReceipt(
      output,
      createCiEvidenceWorkflowReceipt({
        environment: {
          GITHUB_REPOSITORY: process.env['GITHUB_REPOSITORY'],
          GITHUB_EVENT_NAME: process.env['GITHUB_EVENT_NAME'],
          GITHUB_EVENT_PATH: process.env['GITHUB_EVENT_PATH'],
          GITHUB_WORKFLOW_REF: process.env['GITHUB_WORKFLOW_REF'],
          GITHUB_WORKFLOW_SHA: process.env['GITHUB_WORKFLOW_SHA'],
          GITHUB_RUN_ID: process.env['GITHUB_RUN_ID'],
          GITHUB_RUN_ATTEMPT: process.env['GITHUB_RUN_ATTEMPT'],
          VERIFICATION_REQUEST: process.env['VERIFICATION_REQUEST'],
          VERIFICATION_PLAN: process.env['VERIFICATION_PLAN'],
          VERIFICATION_BASE: process.env['VERIFICATION_BASE'],
          CI_EVIDENCE_NEEDS: process.env['CI_EVIDENCE_NEEDS'],
          CI_EVIDENCE_NOT_APPLICABLE: process.env['CI_EVIDENCE_NOT_APPLICABLE'],
          CI_EVIDENCE_ARTIFACT_DIRECTORY: process.env['CI_EVIDENCE_ARTIFACT_DIRECTORY'],
        },
        eventPayload: readEventPayload(process.env['GITHUB_EVENT_PATH']),
        git,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown receipt failure';
    process.stderr.write(`ci-evidence-workflow: ${message}\n`);
    process.exitCode = 1;
  }
}
