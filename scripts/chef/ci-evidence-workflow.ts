#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { rootScriptEnvironment } from '../environment-configuration.ts';
import { parseJUnit } from './evidence-provider.ts';

export class CiEvidenceWorkflowError extends Error {}

// The authenticated P07 reference inventory has 73 reports totaling 24.5 MB; the largest is 4.5 MB
// and reports are five directories below their artifact root. These bounds leave headroom without
// allowing one downloaded artifact to consume the aggregate runner's memory unboundedly.
export const MAX_JUNIT_REPORTS = 128;
export const MAX_JUNIT_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_JUNIT_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_JUNIT_DIRECTORY_DEPTH = 8;

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
  CI_EVIDENCE_EXPECTED_JOBS?: string | undefined;
  CI_EVIDENCE_ARTIFACT_DIRECTORY?: string | undefined;
  CI_EVIDENCE_TEST_REPORT_DIRECTORY?: string | undefined;
}

interface GitResult {
  code: number;
  stdout: string;
}

export interface CiEvidenceWorkflowReceipt {
  repository: string;
  event: 'pull_request' | 'workflow_dispatch' | 'push' | 'schedule';
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
  /** Test source files observed in the JUnit reports produced by the tests job. */
  testFiles?: string[];
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
      : /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@(?:[0-9a-f]{40}|refs\/[^\s]+)$/i.exec(
          value,
        );
  if (match === undefined || match === null || !repository(environment.GITHUB_REPOSITORY))
    throw new CiEvidenceWorkflowError('GITHUB_WORKFLOW_REF is not a trusted workflow reference');
  if (match[1] !== environment.GITHUB_REPOSITORY)
    throw new CiEvidenceWorkflowError(
      'workflow reference repository does not match GITHUB_REPOSITORY',
    );
  const workflowRevision = requiredCommit(environment.GITHUB_WORKFLOW_SHA, 'GITHUB_WORKFLOW_SHA');
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

function expectedJobs(value: string | undefined): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '');
  } catch {
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_EXPECTED_JOBS is not valid JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((name) => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name)) ||
    new Set(parsed).size !== parsed.length
  )
    throw new CiEvidenceWorkflowError('CI_EVIDENCE_EXPECTED_JOBS must be a unique job-name array');
  return new Set(parsed);
}

function needsInventory(
  value: string | undefined,
  notApplicable: ReadonlySet<string>,
  expected: ReadonlySet<string>,
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
  const names = new Set(Object.keys(entries));
  for (const name of expected)
    if (!names.has(name))
      throw new CiEvidenceWorkflowError(`expected prerequisite ${name} is missing`);
  for (const name of names)
    if (!expected.has(name))
      throw new CiEvidenceWorkflowError(`unexpected prerequisite ${name} is present`);
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

function reportedTestFiles(
  reports: readonly { path: string; content: Uint8Array }[],
): string[] | undefined {
  const files = new Set<string>();
  for (const report of reports) {
    let parsed: ReturnType<typeof parseJUnit>;
    try {
      parsed = parseJUnit(report.content);
    } catch {
      throw new CiEvidenceWorkflowError('pull-request JUnit artifact has malformed XML');
    }
    if (!parsed.assertionPassed)
      throw new CiEvidenceWorkflowError('pull-request JUnit artifact contains a failed assertion');
    const marker = 'test-output/junit/';
    const position = report.path.indexOf(marker);
    const workspace =
      position < 0 ? undefined : report.path.slice(0, position).replace(/\/$/, '') || '.';
    if (
      workspace === undefined ||
      report.path.split('/').some((part) => part === '..') ||
      (workspace !== '.' &&
        workspace.split('/').some((part) => part === '' || part === '.' || part === '..'))
    )
      throw new CiEvidenceWorkflowError('pull-request JUnit artifact has an unsafe report path');
    for (const file of parsed.files) {
      if (
        !/^[A-Za-z0-9_./-]+\.test\.ts$/.test(file) ||
        file.split('/').some((part) => part === '' || part === '.' || part === '..')
      )
        throw new CiEvidenceWorkflowError('pull-request JUnit artifact has an invalid test file');
      files.add(workspace === '.' ? file : `${workspace}/${file}`);
    }
  }
  return files.size === 0 ? undefined : [...files].toSorted();
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

export function readJUnitArtifactReportEntries(directory: string): {
  path: string;
  content: Uint8Array;
}[] {
  const files: { path: string; content: Uint8Array }[] = [];
  let totalBytes = 0;
  const visit = (path: string, depth: number): void => {
    if (depth > MAX_JUNIT_DIRECTORY_DEPTH)
      throw new CiEvidenceWorkflowError('JUnit artifact exceeds maximum directory depth');
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      const link = lstatSync(child);
      if (link.isSymbolicLink())
        throw new CiEvidenceWorkflowError('JUnit artifact contains a symbolic link');
      if (link.isDirectory()) visit(child, depth + 1);
      else if (link.isFile() && entry.name.endsWith('.xml')) {
        if (files.length >= MAX_JUNIT_REPORTS)
          throw new CiEvidenceWorkflowError('JUnit artifact has too many reports');
        const status = statSync(child);
        if (status.size > MAX_JUNIT_REPORT_BYTES)
          throw new CiEvidenceWorkflowError('JUnit artifact report exceeds maximum size');
        totalBytes += status.size;
        if (totalBytes > MAX_JUNIT_TOTAL_BYTES)
          throw new CiEvidenceWorkflowError('JUnit artifact reports exceed total size limit');
        files.push({ path: child.slice(directory.length + 1), content: readFileSync(child) });
      }
    }
  };
  try {
    visit(directory, 0);
  } catch (error) {
    if (error instanceof CiEvidenceWorkflowError) throw error;
    throw new CiEvidenceWorkflowError(
      `required JUnit artifact directory ${directory} is unreadable`,
    );
  }
  return files;
}

export function readJUnitArtifactReports(directory: string): Uint8Array[] {
  return readJUnitArtifactReportEntries(directory).map((report) => report.content);
}

const expectedArtifacts = [
  'junit-root',
  ...Array.from({ length: 12 }, (_, index) => `junit-tests-${index}`),
];

export function createCiEvidenceWorkflowReceipt(input: {
  environment: CiEvidenceWorkflowEnvironment;
  eventPayload: unknown;
  git: (command: readonly string[]) => GitResult;
}): CiEvidenceWorkflowReceipt {
  const { environment } = input;
  if (!repository(environment.GITHUB_REPOSITORY))
    throw new CiEvidenceWorkflowError('GITHUB_REPOSITORY is invalid');
  const event = environment.GITHUB_EVENT_NAME;
  if (
    event !== 'pull_request' &&
    event !== 'workflow_dispatch' &&
    event !== 'push' &&
    event !== 'schedule'
  )
    throw new CiEvidenceWorkflowError('unsupported GitHub event');
  const { workflowPath, workflowRevision } = readWorkflowReference(environment);
  const checkedRevision = checkedCommit(input.git, 'HEAD');
  const checkedTree = checkedCommit(input.git, 'HEAD^{tree}');
  const jobs = needsInventory(
    environment.CI_EVIDENCE_NEEDS,
    notApplicableJobs(environment.CI_EVIDENCE_NOT_APPLICABLE),
    expectedJobs(environment.CI_EVIDENCE_EXPECTED_JOBS),
  );
  const manualValues = [
    environment.VERIFICATION_REQUEST,
    environment.VERIFICATION_PLAN,
    environment.VERIFICATION_BASE,
  ];
  const manualBound =
    event === 'workflow_dispatch' &&
    manualValues.every((value) => value !== undefined && value !== '');
  const manualUnbound =
    event === 'workflow_dispatch' &&
    manualValues.every((value) => value === undefined || value === '');
  if (event === 'workflow_dispatch' && !manualBound && !manualUnbound)
    throw new CiEvidenceWorkflowError(
      'manual verification inputs must be all supplied or all empty',
    );
  const base =
    event === 'pull_request'
      ? payloadCommit(input.eventPayload, 'base')
      : event === 'push'
        ? pushCommit(input.eventPayload, 'before')
        : manualBound
          ? requiredCommit(environment.VERIFICATION_BASE, 'VERIFICATION_BASE')
          : checkedCommit(input.git, 'HEAD^');
  const candidate =
    event === 'pull_request'
      ? payloadCommit(input.eventPayload, 'head')
      : event === 'push'
        ? pushCommit(input.eventPayload, 'after')
        : checkedRevision;
  const planDigest = manualBound
    ? requiredDigest(environment.VERIFICATION_PLAN, 'VERIFICATION_PLAN')
    : derivedPlanDigest({ event, workflowPath, workflowRevision, jobs });
  const requestKey = manualBound
    ? requiredDigest(environment.VERIFICATION_REQUEST, 'VERIFICATION_REQUEST')
    : '';
  const attempt = requiredPositiveInteger(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  const reportDirectory = environment.CI_EVIDENCE_ARTIFACT_DIRECTORY;
  const testReportDirectory = environment.CI_EVIDENCE_TEST_REPORT_DIRECTORY;
  const testFiles =
    event === 'pull_request' && testReportDirectory !== undefined && existsSync(testReportDirectory)
      ? reportedTestFiles(readJUnitArtifactReportEntries(testReportDirectory))
      : undefined;
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
            Object.fromEntries(
              expectedArtifacts.map((name) => [
                name,
                readJUnitArtifactReports(`${reportDirectory}/${name}`),
              ]),
            ),
            expectedArtifacts,
          ),
        }),
    ...(testFiles === undefined ? {} : { testFiles }),
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
  const environment = rootScriptEnvironment();
  try {
    writeCiEvidenceWorkflowReceipt(
      output,
      createCiEvidenceWorkflowReceipt({
        environment: {
          GITHUB_REPOSITORY: environment['GITHUB_REPOSITORY'],
          GITHUB_EVENT_NAME: environment['GITHUB_EVENT_NAME'],
          GITHUB_EVENT_PATH: environment['GITHUB_EVENT_PATH'],
          GITHUB_WORKFLOW_REF: environment['GITHUB_WORKFLOW_REF'],
          GITHUB_WORKFLOW_SHA: environment['GITHUB_WORKFLOW_SHA'],
          GITHUB_RUN_ID: environment['GITHUB_RUN_ID'],
          GITHUB_RUN_ATTEMPT: environment['GITHUB_RUN_ATTEMPT'],
          VERIFICATION_REQUEST: environment['VERIFICATION_REQUEST'],
          VERIFICATION_PLAN: environment['VERIFICATION_PLAN'],
          VERIFICATION_BASE: environment['VERIFICATION_BASE'],
          CI_EVIDENCE_NEEDS: environment['CI_EVIDENCE_NEEDS'],
          CI_EVIDENCE_NOT_APPLICABLE: environment['CI_EVIDENCE_NOT_APPLICABLE'],
          CI_EVIDENCE_EXPECTED_JOBS: environment['CI_EVIDENCE_EXPECTED_JOBS'],
          CI_EVIDENCE_ARTIFACT_DIRECTORY: environment['CI_EVIDENCE_ARTIFACT_DIRECTORY'],
          CI_EVIDENCE_TEST_REPORT_DIRECTORY: environment['CI_EVIDENCE_TEST_REPORT_DIRECTORY'],
        },
        eventPayload: readEventPayload(environment['GITHUB_EVENT_PATH']),
        git,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown receipt failure';
    process.stderr.write(`ci-evidence-workflow: ${message}\n`);
    process.exitCode = 1;
  }
}
