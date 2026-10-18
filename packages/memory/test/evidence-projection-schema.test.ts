import { describe, expect, it } from 'bun:test';

import {
  decodeEvidenceProjectionRecord,
  encodeEvidenceProjectionRecord,
  MAX_PROJECTION_REVISION,
  PROJECTION_KINDS,
  projectionText,
} from '../src/evidence-projection-schema';
import {
  MemoryEvidenceValidationError,
  type MemoryEvidenceRejectionCode,
} from '../src/evidence-schema';
import {
  FIXED_AT,
  makeFact,
  makeInlineEvidence,
  nextRevision,
  OTHER_TENANT,
  TENANT,
} from './evidence-projection-fixtures';

const evidence = makeInlineEvidence('e1');

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeFact('p1', [evidence], overrides);
}

function codeOf(raw: unknown): MemoryEvidenceRejectionCode {
  try {
    decodeEvidenceProjectionRecord(raw, { tenantId: TENANT });
  } catch (error) {
    if (error instanceof MemoryEvidenceValidationError) {
      expect(error.record).toBe('projection');
      return error.code;
    }
    throw error;
  }
  throw new Error('Expected decodeEvidenceProjectionRecord to reject.');
}

describe('projection schema rejection', () => {
  it('accepts a well-formed record', () => {
    expect(decodeEvidenceProjectionRecord(valid(), { tenantId: TENANT }).id).toBe('p1');
  });

  it('rejects a malformed record', () => {
    expect(codeOf(valid({ confidence: 1.5 }))).toBe('malformed');
    expect(codeOf(valid({ status: 'gone' }))).toBe('malformed');
    expect(codeOf(valid({ kind: 'index' }))).toBe('malformed');
    expect(codeOf(null)).toBe('malformed');
    expect(codeOf([])).toBe('malformed');
  });

  it('rejects a record of another tenant', () => {
    expect(codeOf(valid({ tenantId: OTHER_TENANT }))).toBe('cross-tenant');
  });

  it('rejects a source-less record, whether sources is empty or missing', () => {
    expect(codeOf(valid({ sources: [] }))).toBe('source-less');
    const missing = valid();
    delete missing['sources'];
    expect(codeOf(missing)).toBe('source-less');
  });

  it('treats a bad element inside sources as malformed, not source-less', () => {
    expect(codeOf(valid({ sources: [{ evidenceId: 'e1', digest: 'nope' }] }))).toBe('malformed');
  });

  it('rejects an unsupported schema version before parsing', () => {
    expect(codeOf(valid({ schemaVersion: 2, newField: 1 }))).toBe('unsupported-revision');
    expect(codeOf(valid({ schemaVersion: 0 }))).toBe('unsupported-revision');
  });

  it('rejects an unknown key at the top level, in the payload, and in the transition', () => {
    expect(codeOf(valid({ surprise: 1 }))).toBe('malformed');
    expect(codeOf(valid({ payload: { statement: 's', entities: [], extra: 1 } }))).toBe(
      'malformed',
    );
    expect(codeOf(valid({ transition: { kind: 'created', at: FIXED_AT, extra: 1 } }))).toBe(
      'malformed',
    );
  });
});

describe('projection invariants', () => {
  it('makes status a function of transition.kind', () => {
    expect(codeOf(valid({ status: 'superseded' }))).toBe('malformed');
    const rebuilt = {
      transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
      revision: 2,
    };
    expect(codeOf(valid({ ...rebuilt, status: 'revoked' }))).toBe('malformed');
    expect(decodeEvidenceProjectionRecord(valid(rebuilt), { tenantId: TENANT }).status).toBe(
      'active',
    );
  });

  it('reserves revision 1 for the created transition and nothing else', () => {
    expect(codeOf(valid({ revision: 2 }))).toBe('malformed');
    expect(
      codeOf(valid({ transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 } })),
    ).toBe('malformed');
  });

  it('requires a rebuild to follow the revision it rebuilds', () => {
    expect(
      codeOf(
        valid({
          revision: 2,
          transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 2 },
        }),
      ),
    ).toBe('malformed');
  });

  it('requires distinct sources and a non-empty half-open validity', () => {
    const source = { evidenceId: 'e1', digest: evidence.digest };
    expect(codeOf(valid({ sources: [source, source] }))).toBe('malformed');
    expect(codeOf(valid({ validity: { validFrom: 5, validUntil: 5 } }))).toBe('malformed');
    expect(
      decodeEvidenceProjectionRecord(valid({ validity: { validFrom: 5, validUntil: 6 } }), {
        tenantId: TENANT,
      }).validity,
    ).toEqual({ validFrom: 5, validUntil: 6 });
  });

  it('encodes the same record to the same bytes whatever the key order', () => {
    const record = decodeEvidenceProjectionRecord(valid(), { tenantId: TENANT });
    const reordered = Object.fromEntries(Object.entries(record).toReversed());
    const again = decodeEvidenceProjectionRecord(reordered, { tenantId: TENANT });
    expect(encodeEvidenceProjectionRecord(again)).toEqual(encodeEvidenceProjectionRecord(record));
  });

  it('keeps six persisted kinds and no index kind', () => {
    expect(PROJECTION_KINDS).toEqual([
      'fact',
      'episode',
      'procedure',
      'preference',
      'summary',
      'chunk',
    ]);
  });

  it('renders one lexical surface per kind', () => {
    const base = decodeEvidenceProjectionRecord(valid(), { tenantId: TENANT });
    expect(projectionText(base)).toBe('Statement of p1.');
    const preference = {
      ...base,
      kind: 'preference',
      payload: { subject: 'Ana', statement: 'likes tea' },
    };
    expect(projectionText(preference as typeof base)).toBe('Ana likes tea');
    const procedure = {
      ...base,
      kind: 'procedure',
      payload: { title: 'Brew', steps: ['boil', 'steep'] },
    };
    expect(projectionText(procedure as typeof base)).toBe('Brew\nboil\nsteep');
    expect(nextRevision(base, {}).revision).toBe(2);
  });
});

const REBUILT = (revision: number) => ({
  revision,
  transition: { kind: 'rebuilt', at: FIXED_AT, rebuiltFromRevision: 1 },
});

describe('projection bounds and ranges', () => {
  it('[item 14] bounds the revision, with every other rule satisfied', () => {
    expect(
      decodeEvidenceProjectionRecord(valid(REBUILT(MAX_PROJECTION_REVISION)), { tenantId: TENANT })
        .revision,
    ).toBe(MAX_PROJECTION_REVISION);
    expect(codeOf(valid(REBUILT(MAX_PROJECTION_REVISION + 1)))).toBe('malformed');
  });

  it('[item 8] rejects an episode that ends before it begins', () => {
    const episode = (occurredTo: number | undefined) =>
      valid({
        kind: 'episode',
        payload: {
          summary: 'An episode.',
          occurredFrom: FIXED_AT + 10,
          ...(occurredTo === undefined ? {} : { occurredTo }),
        },
      });
    expect(codeOf(episode(FIXED_AT + 9))).toBe('malformed');
    expect(decodeEvidenceProjectionRecord(episode(FIXED_AT + 10), { tenantId: TENANT }).kind).toBe(
      'episode',
    );
    expect(decodeEvidenceProjectionRecord(episode(undefined), { tenantId: TENANT }).kind).toBe(
      'episode',
    );
  });

  it('[item 8] rejects a chunk whose last line precedes its first', () => {
    const chunk = (startLine: number, endLine: number) =>
      valid({
        kind: 'chunk',
        payload: {
          text: 'Chunk text.',
          ordinal: 0,
          startLine,
          endLine,
          steps: [
            {
              step: 'chunk',
              producer: { kind: 'service', id: 'chunker' },
              inputDigest: evidence.digest,
              outputDigest: evidence.digest,
            },
          ],
        },
      });
    expect(codeOf(chunk(5, 4))).toBe('malformed');
    expect(decodeEvidenceProjectionRecord(chunk(4, 4), { tenantId: TENANT }).kind).toBe('chunk');
  });

  it('[item 9] rejects a chunk with more than one source', () => {
    const other = makeInlineEvidence('e2');
    const chunk = (sources: unknown[]) =>
      valid({
        kind: 'chunk',
        sources,
        payload: {
          text: 'Chunk text.',
          ordinal: 0,
          startLine: 0,
          endLine: 1,
          steps: [
            {
              step: 'chunk',
              producer: { kind: 'service', id: 'chunker' },
              inputDigest: evidence.digest,
              outputDigest: evidence.digest,
            },
          ],
        },
      });
    const one = { evidenceId: 'e1', digest: evidence.digest };
    const two = { evidenceId: 'e2', digest: other.digest };
    expect(codeOf(chunk([one, two]))).toBe('malformed');
    expect(decodeEvidenceProjectionRecord(chunk([one]), { tenantId: TENANT }).kind).toBe('chunk');
  });
});

describe('every projection kind decodes', () => {
  const payloads: Record<string, unknown> = {
    fact: { statement: 'A fact.', entities: [] },
    episode: { summary: 'An episode.', occurredFrom: FIXED_AT },
    procedure: { title: 'Brew', steps: ['boil', 'steep'] },
    preference: { subject: 'Ana', statement: 'likes tea' },
    summary: { text: 'A summary.', covers: [{ id: 'p0', revision: 1 }] },
    chunk: {
      text: 'A chunk.',
      ordinal: 0,
      startLine: 0,
      endLine: 0,
      steps: [
        {
          step: 'chunk',
          producer: { kind: 'service', id: 'chunker' },
          inputDigest: evidence.digest,
          outputDigest: evidence.digest,
        },
      ],
    },
  };

  it('[item 15] decodes one valid record of each persisted kind', () => {
    expect(Object.keys(payloads)).toEqual([...PROJECTION_KINDS]);
    for (const kind of PROJECTION_KINDS) {
      const decoded = decodeEvidenceProjectionRecord(valid({ kind, payload: payloads[kind] }), {
        tenantId: TENANT,
      });
      expect(decoded.kind).toBe(kind);
    }
  });

  it('[item 15] renders the procedure lexical surface from a decoded record', () => {
    const procedure = decodeEvidenceProjectionRecord(
      valid({ kind: 'procedure', payload: payloads['procedure'] }),
      { tenantId: TENANT },
    );
    expect(projectionText(procedure)).toBe('Brew\nboil\nsteep');
  });
});

describe('encoders parse their input', () => {
  it('[item 16] refuses an invalid projection instead of writing it', () => {
    const invalid = {
      ...decodeEvidenceProjectionRecord(valid(), { tenantId: TENANT }),
      confidence: 7,
    };
    expect(() => encodeEvidenceProjectionRecord(invalid)).toThrow();
  });

  it('[item 16] encodes a caller object with reordered keys to the canonical bytes', () => {
    const record = decodeEvidenceProjectionRecord(valid(), { tenantId: TENANT });
    const reordered = Object.fromEntries(Object.entries(record).toReversed()) as typeof record;
    expect(encodeEvidenceProjectionRecord(reordered)).toEqual(
      encodeEvidenceProjectionRecord(record),
    );
  });
});
