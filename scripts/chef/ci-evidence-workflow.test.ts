import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CiEvidenceWorkflowError,
  createCiEvidenceWorkflowReceipt,
  type CiEvidenceWorkflowEnvironment,
} from './ci-evidence-workflow.ts';

const sha = (character: string) => character.repeat(40);
const digest = (character: string) => character.repeat(64);

function environment(
  overrides: Partial<CiEvidenceWorkflowEnvironment> = {},
): CiEvidenceWorkflowEnvironment {
  return {
    GITHUB_REPOSITORY: 'stevekinney/corvidae',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: '/event.json',
    GITHUB_WORKFLOW_REF: `stevekinney/corvidae/.github/workflows/main.yml@${sha('a')}`,
    GITHUB_WORKFLOW_SHA: sha('a'),
    GITHUB_RUN_ID: '17',
    GITHUB_RUN_ATTEMPT: '2',
    VERIFICATION_REQUEST: digest('d'),
    VERIFICATION_PLAN: digest('e'),
    VERIFICATION_BASE: sha('b'),
    CI_EVIDENCE_NEEDS: '{"root":{"result":"success"}}',
    ...overrides,
  };
}

const git = (command: readonly string[]) => {
  if (command.join(' ') === 'git rev-parse HEAD') return { code: 0, stdout: `${sha('c')}\n` };
  if (command.join(' ') === 'git rev-parse HEAD^{tree}')
    return { code: 0, stdout: `${sha('f')}\n` };
  throw new Error(`unexpected command: ${command.join(' ')}`);
};

describe('createCiEvidenceWorkflowReceipt', () => {
  test('records a manually dispatched run from trusted Actions identity and the checked tree', () => {
    expect(
      createCiEvidenceWorkflowReceipt({
        environment: environment(),
        eventPayload: {},
        git,
      }),
    ).toEqual({
      repository: 'stevekinney/corvidae',
      event: 'workflow_dispatch',
      workflowPath: '.github/workflows/main.yml',
      workflowRevision: sha('a'),
      requestKey: digest('d'),
      planDigest: digest('e'),
      base: sha('b'),
      candidate: sha('c'),
      checkedRevision: sha('c'),
      checkedTree: sha('f'),
      runId: 17,
      attempt: 2,
      jobs: { root: 'success' },
    });
  });

  test('uses the pull request payload for base and candidate while retaining the merge checkout', () => {
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'pull_request',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
      }),
      eventPayload: { pull_request: { base: { sha: sha('b') }, head: { sha: sha('d') } } },
      git,
    });
    expect(receipt).toMatchObject({
      event: 'pull_request',
      base: sha('b'),
      candidate: sha('d'),
      checkedRevision: sha('c'),
      checkedTree: sha('f'),
    });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).not.toBe(digest('d'));
  });

  test('uses the push payload instead of manual dispatch values', () => {
    const receipt = createCiEvidenceWorkflowReceipt({
      environment: environment({
        GITHUB_EVENT_NAME: 'push',
        VERIFICATION_REQUEST: undefined,
        VERIFICATION_PLAN: undefined,
        VERIFICATION_BASE: undefined,
      }),
      eventPayload: { before: sha('b'), after: sha('c') },
      git,
    });
    expect(receipt).toMatchObject({ event: 'push', base: sha('b'), candidate: sha('c') });
    expect(receipt.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.requestKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a manual receipt with a missing digest, malformed workflow reference, or skipped dependency', () => {
    for (const overrides of [
      { VERIFICATION_PLAN: '' },
      { GITHUB_WORKFLOW_REF: 'not-a-workflow-reference' },
      { CI_EVIDENCE_NEEDS: '{"root":{"result":"skipped"}}' },
    ]) {
      expect(() =>
        createCiEvidenceWorkflowReceipt({
          environment: environment(overrides),
          eventPayload: {},
          git,
        }),
      ).toThrow(CiEvidenceWorkflowError);
    }
  });

  test('rejects a pull request payload without exact head and base commit identities', () => {
    expect(() =>
      createCiEvidenceWorkflowReceipt({
        environment: environment({
          GITHUB_EVENT_NAME: 'pull_request',
          VERIFICATION_REQUEST: undefined,
          VERIFICATION_PLAN: undefined,
          VERIFICATION_BASE: undefined,
        }),
        eventPayload: { pull_request: { base: { sha: sha('b') }, head: {} } },
        git,
      }),
    ).toThrow('pull_request event payload has no valid head SHA');
  });
});

describe('CI evidence workflow producers', () => {
  const root = join(import.meta.dir, '..', '..');
  const main = readFileSync(join(root, '.github/workflows/main.yml'), 'utf8');
  const pullRequest = readFileSync(join(root, '.github/workflows/pull-request.yml'), 'utf8');

  test('uses the typed producer and attempt-fenced required artifacts instead of shell JSON', () => {
    expect(main).toContain('bun scripts/chef/ci-evidence-workflow.ts ci-evidence-receipt.json');
    expect(main).toContain('name: ci-evidence-receipt-${{ github.run_attempt }}');
    expect(main).not.toContain('printf \'{"requestKey"');
    expect(main).toContain('if-no-files-found: error');
  });

  test('produces independent pull-request evidence with explicit browser non-applicability', () => {
    expect(pullRequest).toContain('name: Evidence aggregate');
    expect(pullRequest).toContain('CI_EVIDENCE_NEEDS: ${{ toJSON(needs) }}');
    expect(pullRequest).toContain('CI_EVIDENCE_NOT_APPLICABLE:');
    expect(pullRequest).toContain('name: ci-evidence-receipt-${{ github.run_attempt }}');
  });
});
