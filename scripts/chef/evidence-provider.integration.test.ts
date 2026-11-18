import { expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { createGitHubEvidenceTransport, type RawCommandResponse } from './evidence-provider.ts';

const encode = (value: unknown): RawCommandResponse => ({
  exitCode: 0,
  stdout: new TextEncoder().encode(JSON.stringify(value)),
  stderr: new Uint8Array(),
});

const validFixture = (() => {
  const archive = zipSync({
    'reports/result.xml': new TextEncoder().encode(
      '<testsuite><testcase name="unit"/></testsuite>',
    ),
  });
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const calls: string[] = [];
  const transport = createGitHubEvidenceTransport('acme/widgets', {
    run(argv) {
      const path = argv.at(-1) as string;
      calls.push(path);
      if (path.endsWith('/runs/7'))
        return encode({
          repository: { full_name: 'acme/widgets' },
          head_sha: 'a'.repeat(40),
          status: 'completed',
          conclusion: 'success',
          name: 'Verify',
          event: 'push',
          run_attempt: 2,
        });
      if (path.endsWith('/jobs?per_page=100&page=1'))
        return encode({
          total_count: 101,
          jobs: [
            {
              id: 3,
              name: 'verify',
              status: 'completed',
              conclusion: 'success',
              runner_name: 'linux',
              steps: [{ name: 'unit' }],
            },
            ...Array.from({ length: 99 }, (_, index) => ({
              id: index + 10,
              name: `other-${index}`,
            })),
          ],
        });
      if (path.endsWith('/jobs?per_page=100&page=2'))
        return encode({ total_count: 101, jobs: [{ id: 200, name: 'other-final' }] });
      if (path.endsWith('/artifacts?per_page=100&page=1'))
        return encode({
          total_count: 1,
          artifacts: [{ id: 9, name: 'junit', digest, expired: false }],
        });
      if (path.endsWith('/artifacts/9/zip'))
        return { exitCode: 0, stdout: archive, stderr: new Uint8Array() };
      throw new Error(`unexpected ${path}`);
    },
  });
  const run = transport.run(7);
  const job = transport.job(7, 'verify');
  const artifact = transport.artifact(7, 'junit');
  const downloaded = transport.downloadArtifact?.(9);
  return {
    archive,
    artifact,
    calls,
    digest,
    job,
    run,
    downloaded,
  };
})();

test('the raw production transport follows every page and retains job and artifact identities', () => {
  expect(validFixture.run).toMatchObject({ repository: 'acme/widgets', attempt: 2 });
  expect(validFixture.job).toMatchObject({ id: 3, runtime: 'linux' });
  expect(validFixture.artifact).toMatchObject({ id: 9, digest: validFixture.digest, runId: 7 });
  expect(validFixture.downloaded).toEqual(validFixture.archive);
  expect(validFixture.calls).toEqual([
    'repos/acme/widgets/actions/runs/7',
    'repos/acme/widgets/actions/runs/7/jobs?per_page=100&page=1',
    'repos/acme/widgets/actions/runs/7/jobs?per_page=100&page=2',
    'repos/acme/widgets/actions/runs/7/artifacts?per_page=100&page=1',
    'repos/acme/widgets/actions/artifacts/9/zip',
  ]);
});

const incompleteError = (() => {
  const transport = createGitHubEvidenceTransport('acme/widgets', {
    run(argv) {
      const path = argv.at(-1) as string;
      if (path.endsWith('/jobs?per_page=100&page=1'))
        return encode({ total_count: 2, jobs: [{ id: 1, name: 'verify' }] });
      if (path.endsWith('/jobs?per_page=100&page=2')) return encode({ total_count: 2, jobs: [] });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    transport.job(7, 'verify');
  } catch (error) {
    return error;
  }
  return undefined;
})();

test('the raw transport refuses ambiguous or incomplete provider pages', () => {
  expect(incompleteError).toBeInstanceOf(Error);
  expect((incompleteError as Error).message).toContain('pagination is incomplete');
});
