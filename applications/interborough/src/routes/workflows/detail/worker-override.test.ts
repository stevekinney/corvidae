import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import { describeOverrideFault, isOverrideTokenRejected } from './worker-override.ts';

function conflict(reason: string): HttpClientError {
  return new HttpClientError(409, 'raw server text that must not be matched', {
    faultCode: 'Conflict',
    data: { reason },
  });
}

describe('isOverrideTokenRejected', () => {
  test('is true for a Conflict whose reason is override-token-rejected', () => {
    expect(isOverrideTokenRejected(conflict('override-token-rejected'))).toBe(true);
  });

  test('is false for other conflicts, other statuses, and non-errors', () => {
    expect(isOverrideTokenRejected(conflict('workflow-not-terminal'))).toBe(false);
    expect(isOverrideTokenRejected(new HttpClientError(409, 'x', { faultCode: 'Conflict' }))).toBe(
      false,
    );
    expect(
      isOverrideTokenRejected(
        new HttpClientError(404, 'x', {
          faultCode: 'NotFound',
          data: { reason: 'override-token-rejected' },
        }),
      ),
    ).toBe(false);
    expect(isOverrideTokenRejected(new Error('override-token-rejected'))).toBe(false);
  });

  test('never matches on message text', () => {
    expect(
      isOverrideTokenRejected(
        new HttpClientError(409, 'override-token-rejected', { faultCode: 'Conflict' }),
      ),
    ).toBe(false);
  });
});

describe('describeOverrideFault', () => {
  test.each([
    ['workflow-not-terminal', /not terminal/],
    ['no-worker-binding', /no durable worker binding/],
    ['policy-not-auto-upgrade', /pinned/],
    ['no-routed-deployment', /No ready, routed deployment/],
    ['upgrade-incompatible-contract', /incompatible-contract/],
    ['override-token-rejected', /expired, already used/],
  ])('maps the %s reason to plain language', (reason, expected) => {
    expect(describeOverrideFault(conflict(reason))).toMatch(expected);
  });

  test('a NotFound says the run no longer exists', () => {
    expect(describeOverrideFault(new HttpClientError(404, 'x', { faultCode: 'NotFound' }))).toMatch(
      /no longer exists/,
    );
  });

  test('an UnsupportedCapability says the server cannot sign previews', () => {
    expect(
      describeOverrideFault(new HttpClientError(501, 'x', { faultCode: 'UnsupportedCapability' })),
    ).toMatch(/signing/);
  });

  test('an unknown conflict reason falls back to the generic fault text', () => {
    expect(describeOverrideFault(conflict('something-new'))).not.toContain('something-new');
  });

  test('a non-HTTP failure uses the generic fault text', () => {
    expect(describeOverrideFault(new Error('boom')).length).toBeGreaterThan(0);
  });
});
