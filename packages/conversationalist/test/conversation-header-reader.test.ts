import { describe, expect, it } from 'bun:test';

import {
  parseConversationFrame,
  readConversationHistoryHeader,
} from '../src/conversation/serialization';

const validHeader = {
  schemaVersion: 1,
  id: 'conversation',
  status: 'active',
  metadata: { tags: ['a', 1, true, null], nested: { depth: 2.5 } },
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const shared = { value: 1 };
const sparse: unknown[] = [];
sparse[0] = 1;
sparse[2] = 2;
const cyclic: Record<string, unknown> = {};
cyclic['self'] = cyclic;

/** Headers each reader must agree on: the schema-backed frame decides the expected outcome. */
const headers: Array<[string, unknown]> = [
  ['a valid header', validHeader],
  ['a titled header', { ...validHeader, title: 'Weather' }],
  ['an explicitly undefined title', { ...validHeader, title: undefined }],
  ['a null-prototype metadata', { ...validHeader, metadata: Object.create(null) }],
  ['a value shared by two branches', { ...validHeader, metadata: { a: shared, b: [shared] } }],
  ['a null title', { ...validHeader, title: null }],
  ['a numeric title', { ...validHeader, title: 3 }],
  ['an unknown status', { ...validHeader, status: 'paused' }],
  ['a missing status', { ...validHeader, status: undefined }],
  ['a fractional schema version', { ...validHeader, schemaVersion: 1.5 }],
  ['a zero schema version', { ...validHeader, schemaVersion: 0 }],
  ['a string schema version', { ...validHeader, schemaVersion: '1' }],
  ['a numeric id', { ...validHeader, id: 7 }],
  ['a numeric createdAt', { ...validHeader, createdAt: 0 }],
  ['a missing updatedAt', { ...validHeader, updatedAt: undefined }],
  ['an unknown field', { ...validHeader, surprise: true }],
  ['array metadata', { ...validHeader, metadata: [] }],
  ['null metadata', { ...validHeader, metadata: null }],
  ['a non-finite metadata number', { ...validHeader, metadata: { n: Number.NaN } }],
  ['an infinite nested number', { ...validHeader, metadata: { n: [Infinity] } }],
  ['an undefined metadata value', { ...validHeader, metadata: { u: undefined } }],
  ['a function metadata value', { ...validHeader, metadata: { f: () => 1 } }],
  ['a class instance metadata value', { ...validHeader, metadata: { d: new Date(0) } }],
  ['a sparse array metadata value', { ...validHeader, metadata: { a: sparse } }],
  ['a header that is an array', []],
  ['a header that is a string', 'header'],
];

function frameHeader(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return parseConversationFrame(value).header;
  }
  return parseConversationFrame({ ...value, ids: [], messages: {} }).header;
}

function outcome(read: () => unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false };
  }
}

describe('readConversationHistoryHeader', () => {
  for (const [name, header] of headers) {
    it(`agrees with the schema-backed frame on ${name}`, () => {
      const expected = outcome(() => frameHeader(header));
      const actual = outcome(() => readConversationHistoryHeader(header));
      expect(actual.ok).toBe(expected.ok);
      if (actual.ok && expected.ok) expect(actual.value).toEqual(expected.value);
    });
  }

  it('returns metadata that shares no containers with its input', () => {
    const header = readConversationHistoryHeader(validHeader);
    expect(header.metadata).toEqual(validHeader.metadata);
    expect(header.metadata).not.toBe(validHeader.metadata);
    expect(header.metadata['tags']).not.toBe(validHeader.metadata.tags);
    expect(header.metadata['nested']).not.toBe(validHeader.metadata.nested);
  });

  // The two places the readers deliberately differ. Neither input can reach a
  // restore through a snapshot, which is decoded JSON and is hashed before any
  // header is read, but the reader handles both safely on its own.
  it('rejects cyclic metadata, which is not a JSON value', () => {
    expect(() => readConversationHistoryHeader({ ...validHeader, metadata: cyclic })).toThrow(
      'invalid header metadata: cycle',
    );
  });

  it('keeps a __proto__ metadata key as an own property', () => {
    const header = readConversationHistoryHeader({
      ...validHeader,
      metadata: JSON.parse('{"__proto__":{"x":1}}'),
    });
    expect(Object.keys(header.metadata)).toEqual(['__proto__']);
    expect(Reflect.getPrototypeOf(header.metadata)).toBe(Object.prototype);
    // The schema-backed frame instead turns the key into the record's prototype.
    const frame = frameHeader({ ...validHeader, metadata: JSON.parse('{"__proto__":{"x":1}}') });
    expect(Object.keys((frame as { metadata: object }).metadata)).toEqual([]);
  });
});
