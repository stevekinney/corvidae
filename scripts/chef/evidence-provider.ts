import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { SaxesParser } from 'saxes';
import {
  EvidenceRequestError,
  type ProviderEvidenceTransport,
  type ProviderJob,
  type ProviderRun,
} from './evidence-transport.ts';

interface GitHubObject {
  artifacts?: unknown;
  conclusion?: unknown;
  digest?: unknown;
  event?: unknown;
  expired?: unknown;
  full_name?: unknown;
  head_sha?: unknown;
  id?: unknown;
  jobs?: unknown;
  name?: unknown;
  repository?: unknown;
  run_attempt?: unknown;
  path?: unknown;
  runner_name?: unknown;
  status?: unknown;
  steps?: unknown;
  size_in_bytes?: unknown;
  total_count?: unknown;
}
export interface RawCommandResponse {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}
export interface RawCommandTransport {
  run(argv: string[]): RawCommandResponse;
}

function object(value: unknown): GitHubObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new EvidenceRequestError('authenticated GitHub response has invalid shape');
  return value;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}
function json(response: RawCommandResponse): unknown {
  if (response.exitCode !== 0) throw new EvidenceRequestError('authenticated GitHub query failed');
  try {
    return JSON.parse(new TextDecoder().decode(response.stdout));
  } catch {
    throw new EvidenceRequestError('authenticated GitHub response was not JSON');
  }
}
function query(repository: string, path: string, raw: RawCommandTransport): GitHubObject {
  return object(json(raw.run(['gh', 'api', `repos/${repository}/${path}`])));
}

/** Fetch every numbered page and reject a provider response with an unaccounted-for total. */
function pages(
  repository: string,
  path: string,
  key: 'jobs' | 'artifacts',
  raw: RawCommandTransport,
): GitHubObject[] {
  const values: GitHubObject[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= 1000; page += 1) {
    const value = query(repository, `${path}?per_page=100&page=${page}`, raw);
    const total = integer(value.total_count);
    const entries = value[key];
    if (total === undefined || !Array.isArray(entries))
      throw new EvidenceRequestError('authenticated GitHub page has invalid shape');
    if (expected === undefined) expected = total;
    if (expected !== total || values.length + entries.length > expected)
      throw new EvidenceRequestError('authenticated GitHub pagination is inconsistent');
    values.push(...entries.map(object));
    if (values.length === expected) return values;
    if (entries.length === 0)
      throw new EvidenceRequestError('authenticated GitHub pagination is incomplete');
  }
  throw new EvidenceRequestError('authenticated GitHub pagination exceeds limit');
}
function unique<T>(values: T[], description: string): T {
  if (values.length !== 1)
    throw new EvidenceRequestError(`authenticated GitHub ${description} is ambiguous or missing`);
  return values[0] as T;
}
function defaultRawTransport(): RawCommandTransport {
  return {
    run(argv) {
      const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

/** Default authenticated GitHub transport. Credentials remain inside `gh`. */
export function createGitHubEvidenceTransport(
  repository: string,
  raw: RawCommandTransport = defaultRawTransport(),
  cwd = process.cwd(),
): ProviderEvidenceTransport {
  const runs = new Map<number, ProviderRun>();
  const jobs = new Map<string, ProviderJob>();
  return {
    run(id) {
      const cached = runs.get(id);
      if (cached !== undefined) return cached;
      const value = query(repository, `actions/runs/${id}`, raw);
      const run: ProviderRun = {
        repository: string(object(value.repository).full_name),
        revision: string(value.head_sha),
        status: string(value.status),
        conclusion: string(value.conclusion),
        workflow: string(value.name),
        workflowPath: string(value.path),
        event: string(value.event),
        attempt: integer(value.run_attempt) ?? 0,
      };
      runs.set(id, run);
      return run;
    },
    job(id, jobName) {
      const key = `${id}:${jobName}`;
      const cached = jobs.get(key);
      if (cached !== undefined) return cached;
      const value = unique(
        pages(repository, `actions/runs/${id}/jobs`, 'jobs', raw).filter(
          (candidate) => string(candidate.name) === jobName,
        ),
        'job mapping',
      );
      const steps = Array.isArray(value.steps) ? value.steps.map(object) : [];
      const job: ProviderJob = {
        id: integer(value.id) ?? 0,
        name: string(value.name),
        status: string(value.status),
        conclusion: string(value.conclusion),
        runtime: string(value.runner_name),
        inventory: steps.map((step) => string(step.name)).filter(Boolean),
        assertionPassed: null,
      };
      if (job.id < 1 || job.runtime === '')
        throw new EvidenceRequestError('authenticated GitHub job has no execution identity');
      jobs.set(key, job);
      return job;
    },
    artifact(id, artifactName) {
      const matches = pages(repository, `actions/runs/${id}/artifacts`, 'artifacts', raw).filter(
        (candidate) => string(candidate.name) === artifactName,
      );
      if (matches.length === 0) return { present: false, expired: false, runId: id };
      const artifact = unique(matches, 'artifact mapping');
      const artifactId = integer(artifact.id);
      const sizeBytes = integer(artifact.size_in_bytes);
      const digest = string(artifact.digest);
      const run = runs.get(id) ?? this.run(id);
      return {
        present: artifactId !== undefined && digest !== '',
        expired: artifact.expired === true,
        ...(artifactId === undefined ? {} : { id: artifactId }),
        ...(digest === '' ? {} : { digest }),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        runId: id,
        revision: run.revision,
      };
    },
    downloadArtifact(artifactId) {
      const response = raw.run([
        'gh',
        'api',
        `repos/${repository}/actions/artifacts/${artifactId}/zip`,
      ]);
      if (response.exitCode !== 0)
        throw new EvidenceRequestError('authenticated artifact download failed');
      return response.stdout;
    },
    content(revision, _base, inputs) {
      const output = (argv: string[]): Uint8Array | undefined => {
        const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
        return result.exitCode === 0 ? result.stdout : undefined;
      };
      // A run proves its own revision, never a prospective merge with an untested base.
      const tree = output(['git', 'rev-parse', '--verify', `${revision}^{tree}`]);
      const relevantInputs = inputs.map((path) => {
        const content = output(['git', 'show', `${revision}:${path}`]);
        return content === undefined
          ? `${path}:`
          : `${path}:${createHash('sha256').update(content).digest('hex')}`;
      });
      return {
        integrationTree: tree === undefined ? '' : new TextDecoder().decode(tree).trim(),
        relevantInputs,
      };
    },
  };
}

export function parseJUnit(xml: Uint8Array): { inventory: string[]; assertionPassed: boolean } {
  const parser = new SaxesParser({ xmlns: false });
  const inventory: string[] = [];
  let assertionPassed = true;
  parser.on('opentag', (tag) => {
    if (tag.name === 'testcase') {
      const name = tag.attributes['name'];
      if (typeof name === 'string' && name !== '') inventory.push(name);
    }
    if (tag.name === 'failure' || tag.name === 'error') assertionPassed = false;
  });
  parser.on('error', (error) => {
    throw error;
  });
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(xml)).close();
  return { inventory, assertionPassed };
}
export function inspectArtifact(
  bytes: Uint8Array,
  expectedDigest: string | undefined,
): { digest: string; inventory: string[]; assertionPassed: boolean } {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedDigest === undefined || expectedDigest !== `sha256:${digest}`)
    throw new EvidenceRequestError(
      'artifact digest does not match authenticated provider metadata',
    );
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new EvidenceRequestError('artifact is not a valid ZIP archive');
  }
  const reports: Uint8Array[] = [];
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (name.includes('..') || isAbsolute(name) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.xml$/.test(name))
      throw new EvidenceRequestError('artifact has unsafe or non-XML entry');
    reports.push(content);
  }
  if (reports.length === 0) throw new EvidenceRequestError('artifact has no JUnit XML report');
  const parsed = reports.map(parseJUnit);
  return {
    digest,
    inventory: parsed.flatMap((report) => report.inventory),
    assertionPassed: parsed.every((report) => report.assertionPassed),
  };
}
