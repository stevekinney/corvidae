import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft';

import {
  classifyAttribute,
  isEngineOwnedKey,
  parseEditedValue,
  readAttributes,
  setAttribute,
  type AttributesClient,
} from './attributes-data.ts';

function clientAnswering(
  answer: () => Promise<unknown>,
  sets: Array<unknown> = [],
): AttributesClient {
  return {
    operations: {
      'weft.workflows.attributes.get': answer,
      'weft.workflows.attributes.set': async (input: unknown) => {
        sets.push(input);
        return { ok: true as const };
      },
    },
  };
}

describe('classifyAttribute', () => {
  const attributeKind = (value: unknown) => classifyAttribute(value)?.kind ?? null;

  test('tells each value type apart, and a date from a string by the shape Date#toISOString writes', () => {
    expect(attributeKind('us-east')).toBe('string');
    expect(attributeKind(3)).toBe('number');
    expect(attributeKind(false)).toBe('boolean');
    expect(attributeKind('2026-06-15T12:30:00.000Z')).toBe('date');
    expect(attributeKind(['a', 'b'])).toBe('list');
    expect(attributeKind([])).toBe('list');
  });

  test('does not call a looser date-like string a date, and refuses what no attribute holds', () => {
    expect(attributeKind('2026-06-15')).toBe('string');
    expect(attributeKind('2026-06-15T12:30:00Z')).toBe('string');
    expect(attributeKind('2026-13-45T99:99:99.000Z')).toBe('string');
    expect(attributeKind({ nested: true })).toBeNull();
    expect(attributeKind([1, 2])).toBeNull();
    expect(attributeKind(null)).toBeNull();
  });
});

describe('isEngineOwnedKey', () => {
  test('is the weft: prefix and nothing looser', () => {
    expect(isEngineOwnedKey('weft:failureCategory')).toBe(true);
    expect(isEngineOwnedKey('weft-region')).toBe(false);
    expect(isEngineOwnedKey('my:weft:key')).toBe(false);
  });
});

describe('readAttributes', () => {
  test('lists every key with its kind, sorted by key, engine-owned keys marked', async () => {
    const reading = await readAttributes(
      clientAnswering(async () => ({
        region: 'us-east',
        'weft:failureCategory': 'timeout',
        count: 4,
        urgent: true,
        labels: ['a', 'b'],
        dueAt: '2026-06-15T12:30:00.000Z',
      })),
      'wf-1',
    );

    expect(reading.kind).toBe('present');
    if (reading.kind !== 'present') return;
    expect(reading.entries.map((entry) => [entry.key, entry.kind, entry.engineOwned])).toEqual([
      ['count', 'number', false],
      ['dueAt', 'date', false],
      ['labels', 'list', false],
      ['region', 'string', false],
      ['urgent', 'boolean', false],
      ['weft:failureCategory', 'string', true],
    ]);
  });

  test('reads a NotFound, a REST 404, and a null as an empty run', async () => {
    const notFound = new HttpClientError(404, 'Attributes not found', {
      data: { resource: 'attributes' },
    });
    const byFaultCode = Object.assign(new HttpClientError(200, 'Attributes not found'), {
      faultCode: 'NotFound' as const,
    });

    for (const answer of [
      async () => {
        throw notFound;
      },
      async () => {
        throw byFaultCode;
      },
      async () => null,
      async () => ({}),
    ]) {
      expect(await readAttributes(clientAnswering(answer), 'wf-1')).toEqual({ kind: 'empty' });
    }
  });

  test('throws any other fault, and a shape that is not a record', async () => {
    const fault = new HttpClientError(500, 'Internal server error');
    await expect(
      readAttributes(
        clientAnswering(async () => {
          throw fault;
        }),
        'wf-1',
      ),
    ).rejects.toBe(fault);
    await expect(
      readAttributes(
        clientAnswering(async () => ['x']),
        'wf-1',
      ),
    ).rejects.toThrow('unexpected shape');
  });
});

describe('setAttribute', () => {
  test('sends only the edited key', async () => {
    const sets: unknown[] = [];
    await setAttribute(
      clientAnswering(async () => ({}), sets),
      'wf-1',
      'region',
      'eu',
    );
    expect(sets).toEqual([{ workflowId: 'wf-1', attributes: { region: 'eu' } }]);
  });
});

describe('parseEditedValue', () => {
  test('accepts a finite number and refuses an empty or non-numeric draft', () => {
    expect(parseEditedValue('number', '42.5')).toEqual({ ok: true, value: 42.5 });
    expect(parseEditedValue('number', '')).toEqual({ ok: false, reason: 'number' });
    expect(parseEditedValue('number', 'abc')).toEqual({ ok: false, reason: 'number' });
    expect(parseEditedValue('number', 'Infinity')).toEqual({ ok: false, reason: 'number' });
  });

  test('normalises a date draft to an ISO string and refuses one that does not parse', () => {
    expect(parseEditedValue('date', '2026-06-15T12:30:00Z')).toEqual({
      ok: true,
      value: '2026-06-15T12:30:00.000Z',
    });
    expect(parseEditedValue('date', 'next tuesday')).toEqual({ ok: false, reason: 'date' });
  });

  test('passes a string, a boolean and a list through', () => {
    expect(parseEditedValue('string', 'eu')).toEqual({ ok: true, value: 'eu' });
    expect(parseEditedValue('boolean', true)).toEqual({ ok: true, value: true });
    expect(parseEditedValue('list', ['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
  });
});
