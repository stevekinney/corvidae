import { expect, test } from 'bun:test';
import { z } from 'zod';

const job = z.object({
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  outputs: z.record(z.string(), z.string()).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(
    z.object({
      id: z.string().optional(),
      run: z.string().optional(),
      uses: z.string().optional(),
      with: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const { jobs } = z
  .object({
    jobs: z.object({
      package: job,
      'test-package': job,
      publish: job,
      verify: job,
    }),
  })
  .parse(
    Bun.YAML.parse(
      await Bun.file(
        new URL('../.github/workflows/cinder-npm-release.yml', import.meta.url),
      ).text(),
    ),
  );

test('publishes the original artifact only after isolated consumer tests pass', () => {
  const pack = jobs.package;
  const testPackage = jobs['test-package'];
  const upload = pack.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));

  expect(upload?.id).toBe('archive');
  expect(pack.outputs?.['artifact-id']).toBe('${{ steps.archive.outputs.artifact-id }}');

  for (const script of ['verify-agent-library-release.ts', 'verify-cinder-release.ts']) {
    expect(pack.steps.some((step) => step.run?.includes(script))).toBe(false);
    expect(testPackage.steps.some((step) => step.run?.includes(script))).toBe(true);
  }

  expect(testPackage.needs).toBe('package');
  expect(testPackage.permissions?.['id-token']).toBeUndefined();
  expect(jobs.publish.needs).toEqual(['package', 'test-package']);

  for (const consumer of [testPackage, jobs.publish, jobs.verify]) {
    const download = consumer.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.with?.['artifact-ids']).toBe('${{ needs.package.outputs.artifact-id }}');
    expect(download?.with?.name).toBeUndefined();
  }
});
