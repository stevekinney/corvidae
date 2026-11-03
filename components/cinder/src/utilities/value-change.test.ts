import { describe, expect, test } from 'bun:test';

import { commitValue } from './value-change.ts';

describe('commitValue', () => {
  test('commits the proposed value when no handler is provided', () => {
    let value = '';
    commitValue('next', undefined, (next) => {
      value = next;
    });

    expect(value).toBe('next');
  });

  test('commits a transformed handler return value', () => {
    let value = '';
    commitValue(
      'next',
      (next) => next.toUpperCase(),
      (next) => {
        value = next;
      },
    );

    expect(value).toBe('NEXT');
  });

  test('commits the proposed value when the handler returns void', () => {
    let value = '';
    commitValue(
      'next',
      () => {},
      (next) => {
        value = next;
      },
    );

    expect(value).toBe('next');
  });

  test('notifies after the final value is committed', () => {
    let value = '';
    const notifications: string[] = [];

    commitValue(
      'next',
      (next) => next.toUpperCase(),
      (next) => {
        value = next;
      },
      (next) => notifications.push(next),
    );

    expect(value).toBe('NEXT');
    expect(notifications).toEqual(['NEXT']);
  });

  test('commits null returned by a request handler instead of falling back to the proposed value', () => {
    let value: string | null = 'initial';

    const committed = commitValue<string | null>(
      'next',
      () => null,
      (next) => {
        value = next;
      },
    );

    expect(committed).toBeNull();
    expect(value).toBeNull();
  });

  test('does not notify when the request hook returns the previous value', () => {
    const notifications: string[] = [];
    commitValue(
      'next',
      () => 'before',
      () => {},
      (next) => notifications.push(next),
      { value: 'before' },
    );

    expect(notifications).toEqual([]);
  });

  test('notifies when the final value differs from the previous one', () => {
    const notifications: string[] = [];
    commitValue(
      'next',
      undefined,
      () => {},
      (next) => notifications.push(next),
      { value: 'before' },
    );

    expect(notifications).toEqual(['next']);
  });

  test('a refusal that returns null does not notify when null was already held', () => {
    const notifications: Array<string | null> = [];
    commitValue<string | null>(
      'next',
      () => null,
      () => {},
      (next) => notifications.push(next),
      { value: null },
    );

    expect(notifications).toEqual([]);
  });
});
