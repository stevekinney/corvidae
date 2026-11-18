import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { SaxesParser } from 'saxes';
import { EvidenceRequestError, type ProviderEvidenceTransport } from './evidence-transport.ts';

interface GitHubObject {
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  name?: unknown;
  jobs?: unknown;
  steps?: unknown;
  artifacts?: unknown;
  expired?: unknown;
  id?: unknown;
  digest?: unknown;
}
function object(value: unknown): GitHubObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new EvidenceRequestError('authenticated GitHub response has invalid shape');
  return value;
}
function api(repository: string, path: string): unknown {
  const result = Bun.spawnSync(['gh', 'api', `repos/${repository}/${path}`], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new EvidenceRequestError('authenticated GitHub query failed');
  try {
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } catch {
    throw new EvidenceRequestError('authenticated GitHub response was not JSON');
  }
}
/** Default authenticated GitHub transport. Credentials remain inside `gh`. */
export function createGitHubEvidenceTransport(repository: string): ProviderEvidenceTransport {
  return {
    run(id) {
      const value = object(api(repository, `actions/runs/${id}`));
      return {
        revision: typeof value.head_sha === 'string' ? value.head_sha : '',
        status: typeof value.status === 'string' ? value.status : '',
        conclusion: typeof value.conclusion === 'string' ? value.conclusion : '',
        environment: typeof value.name === 'string' ? value.name : '',
      };
    },
    job(id, jobName) {
      const value = object(api(repository, `actions/runs/${id}/jobs?per_page=100`));
      const jobs = Array.isArray(value.jobs) ? value.jobs.map(object) : [];
      const job = jobs.find((candidate) => candidate.name === jobName);
      if (!job) return { conclusion: '', inventory: [], assertionPassed: null };
      const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
      return {
        conclusion: typeof job.conclusion === 'string' ? job.conclusion : '',
        inventory: steps
          .map((step) => (typeof step.name === 'string' ? step.name : ''))
          .filter(Boolean),
        assertionPassed: null,
      };
    },
    artifact(id, artifactName) {
      const value = object(api(repository, `actions/runs/${id}/artifacts?per_page=100`));
      const artifacts = Array.isArray(value.artifacts) ? value.artifacts.map(object) : [];
      const artifact = artifacts.find((candidate) => candidate.name === artifactName);
      return {
        present: artifact !== undefined && artifact.expired !== true,
        ...(typeof artifact?.id === 'number' ? { id: artifact.id } : {}),
        ...(typeof artifact?.digest === 'string' ? { digest: artifact.digest } : {}),
      };
    },
    downloadArtifact(artifactId) {
      const result = Bun.spawnSync(
        ['gh', 'api', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if (result.exitCode !== 0)
        throw new EvidenceRequestError('authenticated artifact download failed');
      return result.stdout;
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
): { inventory: string[]; assertionPassed: boolean } {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedDigest !== undefined && expectedDigest !== `sha256:${digest}`)
    throw new EvidenceRequestError(
      'artifact digest does not match authenticated provider metadata',
    );
  const reports: Uint8Array[] = [];
  for (const [name, content] of Object.entries(unzipSync(bytes))) {
    if (name.endsWith('/')) continue;
    if (name.includes('..') || isAbsolute(name) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.xml$/.test(name))
      throw new EvidenceRequestError('artifact has unsafe or non-XML entry');
    reports.push(content);
  }
  if (reports.length === 0) throw new EvidenceRequestError('artifact has no JUnit XML report');
  const parsed = reports.map(parseJUnit);
  return {
    inventory: parsed.flatMap((report) => report.inventory),
    assertionPassed: parsed.every((report) => report.assertionPassed),
  };
}
