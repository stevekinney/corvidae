import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  conflictReasonOf,
  loadDeploymentOverviews,
  MalformedDeploymentsError,
  parseDeploymentDiagnostics,
  previewRoutingChange,
  staleGenerationOf,
} from './deployments-data.ts';
import { diagnosticsBody, routing, version } from './deployments-test-support.test-support.ts';

describe('parseDeploymentDiagnostics', () => {
  test('accepts versions with and without a routing pointer', () => {
    const parsed = parseDeploymentDiagnostics(diagnosticsBody([version('build-a')], routing()));
    expect(parsed.versions.map((entry) => entry.buildId)).toEqual(['build-a']);
    expect(parsed.routing?.generation).toBe(3);
    expect(parseDeploymentDiagnostics(diagnosticsBody([], null)).routing).toBeNull();
    expect(parseDeploymentDiagnostics({ versions: [] }).routing).toBeNull();
  });

  test.each([
    ['not an object', 'versions'],
    ['no versions list', { routing: null }],
    [
      'a version with an unknown state',
      diagnosticsBody([version('a', { state: 'lost' as never })], null),
    ],
    [
      'a version with negative references',
      diagnosticsBody([version('a', { executionReferences: -1 })], null),
    ],
    [
      'a version with a fractional reference count',
      diagnosticsBody([version('a', { executionReferences: 1.5 })], null),
    ],
    [
      'a version with no digest',
      { versions: [{ deploymentName: 'billing', buildId: 'a' }], routing: null },
    ],
    [
      'a pointer with an out-of-range ramp',
      diagnosticsBody([], routing({ rampBasisPoints: 10_001 })),
    ],
    ['a pointer at generation zero', diagnosticsBody([], routing({ generation: 0 }))],
    ['a pointer that is not an object', { versions: [], routing: 'build-a' }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseDeploymentDiagnostics(value)).toThrow(MalformedDeploymentsError);
  });
});

describe('loadDeploymentOverviews', () => {
  test('names the deployments from the unscoped read, then reads each for its routing pointer', async () => {
    const calls: unknown[] = [];
    const client = {
      operations: {
        'weft.worker.deployments.diagnostics': async (input: { deploymentName?: string }) => {
          calls.push(input);
          if (input.deploymentName === undefined) {
            return diagnosticsBody(
              [
                version('build-b'),
                version('build-a'),
                version('build-x', { deploymentName: 'shipping' }),
              ],
              null,
            );
          }
          return input.deploymentName === 'billing'
            ? diagnosticsBody([version('build-b'), version('build-a')], routing())
            : diagnosticsBody([version('build-x', { deploymentName: 'shipping' })], null);
        },
      },
    };

    const overviews = await loadDeploymentOverviews(client as never);

    expect(calls).toEqual([{}, { deploymentName: 'billing' }, { deploymentName: 'shipping' }]);
    expect(overviews.map((entry) => entry.deploymentName)).toEqual(['billing', 'shipping']);
    expect(overviews[0]?.versions.map((entry) => entry.buildId)).toEqual(['build-a', 'build-b']);
    expect(overviews[0]?.routing?.currentBuildId).toBe('build-a');
    expect(overviews[1]?.routing).toBeNull();
  });

  test('an empty server yields no overviews', async () => {
    const client = {
      operations: {
        'weft.worker.deployments.diagnostics': async () => diagnosticsBody([], null),
      },
    };
    expect(await loadDeploymentOverviews(client as never)).toEqual([]);
  });
});

describe('typed conflicts', () => {
  test('reads the current generation and reason off a stale-generation Conflict', () => {
    const error = new HttpClientError(409, 'changed', {
      data: { reason: 'stale-generation', currentGeneration: 7 },
    });
    expect(staleGenerationOf(error)).toBe(7);
    expect(conflictReasonOf(error)).toBe('stale-generation');
  });

  test('a REST Conflict that discloses only the generation still reads as stale', () => {
    expect(
      staleGenerationOf(new HttpClientError(409, 'changed', { data: { currentGeneration: 0 } })),
    ).toBe(0);
  });

  test('other conflicts, other statuses, and plain errors are not stale', () => {
    const referenced = new HttpClientError(409, 'referenced', {
      data: { reason: 'version-referenced' },
    });
    expect(staleGenerationOf(referenced)).toBeUndefined();
    expect(conflictReasonOf(referenced)).toBe('version-referenced');
    expect(staleGenerationOf(new HttpClientError(404, 'missing'))).toBeUndefined();
    expect(
      staleGenerationOf(new HttpClientError(500, 'oops', { data: { currentGeneration: 2 } })),
    ).toBeUndefined();
    expect(staleGenerationOf(new Error('Routing generation changed'))).toBeUndefined();
    expect(conflictReasonOf(new Error('x'))).toBeUndefined();
  });
});

describe('previewRoutingChange', () => {
  const change = { deploymentName: 'billing', currentBuildId: 'build-a', rampBasisPoints: 0 };

  test('returns the server’s validation and the generation to apply against', async () => {
    const result = await previewRoutingChange(
      {
        operations: {
          'weft.worker.deployments.preview': async () => ({
            valid: true,
            message: 'ok',
            currentGeneration: 4,
          }),
        },
      } as never,
      change,
    );
    expect(result).toEqual({ valid: true, message: 'ok', currentGeneration: 4 });
  });

  test('refuses a preview that carries no generation', async () => {
    const thrown = await previewRoutingChange(
      {
        operations: {
          'weft.worker.deployments.preview': async () => ({ valid: true, message: 'ok' }),
        },
      } as never,
      change,
    ).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(MalformedDeploymentsError);
  });
});
