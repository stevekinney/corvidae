/** Tests for `describeRefreshOutcome` (COR-166): every outcome renders distinctly, as text. */
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  describeRefreshOutcome,
  notActivatedMessage,
  REFRESH_REFUSAL_REASONS,
  refreshFailureLabel,
  refusalReasonLines,
  type RefreshOutcome,
} from './refresh-outcome.ts';

function ok(value: unknown) {
  return describeRefreshOutcome({ ok: true, value }, 'order-processing');
}

function fault(faultCode: string, status: number, data: Record<string, unknown> = {}) {
  return describeRefreshOutcome(
    {
      ok: false,
      error: new HttpClientError(status, 'server message', {
        faultCode: faultCode as never,
        data,
      }),
    },
    'order-processing',
  );
}

describe('describeRefreshOutcome (resolved)', () => {
  test('a 304 is not-modified, with its ETag', () => {
    expect(ok({ status: 'not-modified', etag: 'sha256:abc' })).toEqual({
      kind: 'not-modified',
      etag: 'sha256:abc',
    });
  });

  test('an installed candidate with no activation request is installed', () => {
    expect(ok({ status: 'installed', revision: 'rev-2' })).toEqual({
      kind: 'installed',
      revision: 'rev-2',
    });
  });

  test('an applied activation is activated, with its generation', () => {
    expect(
      ok({
        status: 'activated',
        revision: 'rev-2',
        activation: {
          applied: true,
          pointer: { revision: 'rev-2', generation: 4, activatedAt: 1 },
        },
      }),
    ).toEqual({ kind: 'activated', revision: 'rev-2', generation: 4 });
  });

  test('a stale-generation refusal is installed but not activated, with the current generation', () => {
    const outcome = ok({
      status: 'installed',
      revision: 'rev-2',
      activation: { applied: false, reason: 'stale-generation', currentGeneration: 5 },
    });

    expect(outcome).toEqual({
      kind: 'not-activated',
      revision: 'rev-2',
      refusal: { reason: 'stale-generation', currentGeneration: 5 },
    });
    expect(
      notActivatedMessage((outcome as Extract<RefreshOutcome, { kind: 'not-activated' }>).refusal),
    ).toContain('generation 5');
  });

  test('an incompatible refusal lists every compatibility reason, workflow-version and contract hash included', () => {
    const outcome = ok({
      status: 'installed',
      revision: 'rev-2',
      activation: {
        applied: false,
        reason: 'incompatible',
        compatibilityReasons: ['workflow-version-incompatible', 'contract-hash-mismatch'],
      },
    });

    if (outcome.kind !== 'not-activated') throw new Error('expected not-activated');
    const lines = refusalReasonLines(outcome.refusal);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('workflow-version-incompatible');
    expect(lines[1]).toContain('contract-hash-mismatch');
  });

  test('an activation-conflict refusal is its own outcome', () => {
    const outcome = ok({
      status: 'installed',
      activation: { applied: false, reason: 'conflict' },
    });

    expect(outcome).toEqual({
      kind: 'not-activated',
      revision: undefined,
      refusal: { reason: 'conflict' },
    });
  });

  test('an incompatible refusal whose reasons are not all strings is malformed', () => {
    expect(
      ok({
        status: 'installed',
        activation: { applied: false, reason: 'incompatible', compatibilityReasons: [1] },
      }).kind,
    ).toBe('malformed');
  });

  test.each([
    ['a non-object', 'nope'],
    ['an unknown status', { status: 'sleeping' }],
    ['an activated result without a pointer', { status: 'activated', revision: 'r' }],
    [
      'a refusal without its detail',
      { status: 'installed', activation: { applied: false, reason: 'stale-generation' } },
    ],
    [
      'an unknown refusal',
      { status: 'installed', activation: { applied: false, reason: 'because' } },
    ],
  ])('%s is malformed', (_label, value) => {
    expect(ok(value).kind).toBe('malformed');
  });
});

describe('describeRefreshOutcome (faulted)', () => {
  test.each([...REFRESH_REFUSAL_REASONS])(
    'a refresh-%s conflict is a refused candidate',
    (reason) => {
      const outcome = fault('Conflict', 409, { reason: `refresh-${reason}` });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.reason).toBe(reason);
    },
  );

  test('the refused candidates read distinctly', () => {
    const messages = REFRESH_REFUSAL_REASONS.map((reason) => {
      const outcome = fault('Conflict', 409, { reason: `refresh-${reason}` });
      return outcome.kind === 'refused' ? outcome.message : '';
    });

    expect(new Set(messages).size).toBe(REFRESH_REFUSAL_REASONS.length);
    expect(messages.join(' ')).toMatch(/Integrity/);
    expect(messages.join(' ')).toMatch(/Identity/);
    expect(messages.join(' ')).toMatch(/Contract hash/);
    expect(messages.join(' ')).toMatch(/Runtime validation/);
    expect(messages.join(' ')).toMatch(/Warming/);
  });

  test('any other conflict is a catalog conflict', () => {
    expect(fault('Conflict', 409, { reason: 'catalog-conflict' }).kind).toBe('catalog-conflict');
    expect(fault('Conflict', 409).kind).toBe('catalog-conflict');
  });

  test('an unreachable source is source-unavailable, and a stopped engine says so', () => {
    const unreachable = fault('Unavailable', 503, { reason: 'refresh-source' });
    const stopped = fault('Unavailable', 503, { reason: 'refresh-stopped' });

    expect(unreachable.kind).toBe('source-unavailable');
    expect(stopped.kind).toBe('source-unavailable');
    expect(stopped).not.toEqual(unreachable);
  });

  test('NotFound means no source is registered', () => {
    expect(fault('NotFound', 404).kind).toBe('no-source');
    expect(fault('NotFound', 404, { resource: 'workflow-refresh-source' }).kind).toBe('no-source');
  });

  test('NotFound for a removed revision is not reported as a missing source', () => {
    const outcome = fault('NotFound', 404, {
      resource: 'workflow-revision',
      identifier: 'order-processing:rev-2',
    });

    if (outcome.kind !== 'revision-removed')
      throw new Error(`expected revision-removed, got ${outcome.kind}`);
    expect(outcome.message).not.toMatch(/No refresh source/);
    expect(outcome.message).toContain('rev-2');
  });

  test('InvalidParams, Forbidden, and Unauthorized read as invalid and denied', () => {
    expect(fault('InvalidParams', 400).kind).toBe('invalid');
    expect(fault('Forbidden', 403).kind).toBe('denied');
    expect(fault('Unauthorized', 401).kind).toBe('denied');
  });

  test('an unrecognized fault and a transport failure are faulted, never a guess', () => {
    expect(fault('EngineFailure', 500).kind).toBe('faulted');
    expect(
      describeRefreshOutcome({ ok: false, error: new Error('offline') }, 'order-processing').kind,
    ).toBe('faulted');
    expect(describeRefreshOutcome({ ok: false, error: 'weird' }, 'order-processing').kind).toBe(
      'faulted',
    );
  });
});

describe('refreshFailureLabel', () => {
  test('labels every reason diagnostics can report, distinctly', () => {
    const reasons = [
      'not-registered',
      'source',
      'integrity',
      'identity',
      'contract',
      'runtime',
      'warming',
      'conflict',
      'cancelled',
      'stopped',
      'internal',
    ];

    const labels = reasons.map(refreshFailureLabel);

    expect(new Set(labels).size).toBe(reasons.length);
    expect(labels.join(' ')).not.toContain('Unknown');
  });

  test('an unknown reason is named honestly', () => {
    expect(refreshFailureLabel('gremlins')).toBe('Unknown failure reason: gremlins');
  });
});

describe('notActivatedMessage', () => {
  test('each refusal reads distinctly, with the generation where it has one', () => {
    const messages = [
      notActivatedMessage({ reason: 'stale-generation', currentGeneration: 5 }),
      notActivatedMessage({ reason: 'expected-generation-required', currentGeneration: 6 }),
      notActivatedMessage({ reason: 'incompatible', compatibilityReasons: [] }),
      notActivatedMessage({ reason: 'conflict' }),
    ];

    expect(new Set(messages).size).toBe(4);
    expect(messages[0]).toContain('generation 5');
    expect(messages[1]).toContain('generation 6');
    expect(refusalReasonLines({ reason: 'conflict' })).toEqual([]);
  });
});
