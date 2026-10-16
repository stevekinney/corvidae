import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import VerificationFailureNotice from './verification-failure-notice.svelte';
import { classifyVerificationFailure } from './verification-failure.ts';

/**
 * Messages exactly as `packages/weft/src/worker/strict-json.ts` builds them (`fail(path, message)`
 * yields `${path}: ${message}`, rooted at `activity result` by `worker/activity-table.ts`). They are
 * literals rather than produced by that module, which the dashboard must not depend on.
 */
const STRICT_JSON_MESSAGES = [
  ['activity result: undefined is not valid worker JSON', 'activity result'],
  ['activity result.total: number must be finite', 'activity result.total'],
  ['activity result.balance: negative zero is not valid worker JSON', 'activity result.balance'],
  ['activity result.items[2]: BigInt is not valid worker JSON', 'activity result.items[2]'],
  ['activity result["odd: key"]: function is not valid worker JSON', 'activity result["odd: key"]'],
  ['activity result.when: Date is not a plain JSON object', 'activity result.when'],
  [
    'activity result.list[1]: sparse array slot is not valid worker JSON',
    'activity result.list[1]',
  ],
  ['value.self: cycle is not valid worker JSON', 'value.self'],
] as const;

describe('classifyVerificationFailure', () => {
  test.each(STRICT_JSON_MESSAGES)(
    'recognizes %p as a payload-boundary failure',
    (message, path) => {
      const failure = classifyVerificationFailure(message);
      expect(failure).toEqual({
        kind: 'payload-boundary',
        path,
        detail: message.slice(path.length + 2),
      });
    },
  );

  test('recognizes an in-process WorkerJsonValidationError by name and path', () => {
    const error = Object.assign(new TypeError('activity result.total: number must be finite'), {
      name: 'WorkerJsonValidationError',
      path: 'activity result.total',
    });
    expect(classifyVerificationFailure(error)).toEqual({
      kind: 'payload-boundary',
      path: 'activity result.total',
      detail: 'number must be finite',
    });
  });

  test('recognizes a payload failure carried in an Error message', () => {
    expect(
      classifyVerificationFailure(new Error('activity result: symbol is not valid worker JSON')),
    ).toMatchObject({ kind: 'payload-boundary', path: 'activity result' });
  });

  test('classifies a Conflict fault with compatibility reasons as a contract mismatch', () => {
    const error = new HttpClientError(409, 'Conflict', {
      faultCode: 'Conflict',
      data: { compatibilityReasons: ['contract-hash-mismatch'] },
    });
    expect(classifyVerificationFailure(error)).toEqual({
      kind: 'contract-mismatch',
      reasons: ['contract-hash-mismatch'],
    });
  });

  test('leaves unrelated failures to the caller', () => {
    expect(classifyVerificationFailure('seeded inventory outage')).toBeUndefined();
    expect(classifyVerificationFailure('activity result: card declined')).toBeUndefined();
    expect(
      classifyVerificationFailure('payload: undefined is not valid worker JSON'),
    ).toBeUndefined();
    expect(classifyVerificationFailure(new HttpClientError(500, 'boom'))).toBeUndefined();
    expect(classifyVerificationFailure(null)).toBeUndefined();
    expect(classifyVerificationFailure({ message: 42 })).toBeUndefined();
  });
});

describe('VerificationFailureNotice', () => {
  test('renders a payload-boundary failure with its own copy and path', () => {
    const { container, getByText, queryByText } = render(VerificationFailureNotice, {
      props: {
        failure: {
          kind: 'payload-boundary',
          path: 'activity result.total',
          detail: 'number must be finite',
        },
      },
    });
    expect(getByText('Payload rejected at the worker boundary.')).not.toBeNull();
    expect(getByText('activity result.total')).not.toBeNull();
    expect(container.textContent).toContain('The contract is unchanged');
    expect(queryByText('Contract mismatch.')).toBeNull();
    expect(container.querySelector('[data-failure-kind="payload-boundary"]')).not.toBeNull();
  });

  test('renders a contract mismatch with the compatibility reason labels', () => {
    const { getByText, queryByText, container } = render(VerificationFailureNotice, {
      props: {
        failure: {
          kind: 'contract-mismatch',
          reasons: ['contract-hash-mismatch', 'future-reason'],
        },
      },
    });
    expect(getByText('Contract mismatch.')).not.toBeNull();
    expect(
      getByText('Candidate payload contract differs from the active revision.'),
    ).not.toBeNull();
    expect(getByText('unknown reason: future-reason')).not.toBeNull();
    expect(queryByText('Payload rejected at the worker boundary.')).toBeNull();
    expect(container.querySelector('[data-failure-kind="contract-mismatch"]')).not.toBeNull();
  });
});
