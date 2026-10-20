import { describe, expect, test } from 'bun:test';

import { MEMORY_COPY } from '../../app/copy.ts';
import type { Memory, MemoryLineage } from '../../lib/memory-client.ts';
import { formatMemoryTime, labelFor, lineageFields } from './memory-presentation.ts';

const MEMORY: Memory = {
  id: 'memory-1',
  content: 'The user prefers aisle seats.',
  memoryClass: 'episodic',
  source: 'conversation',
  trust: 'untrusted',
  createdAt: '2026-10-19T08:00:00.000Z',
  sessionId: 'session-1',
};

describe('labelFor', () => {
  test('words a value the page knows, and shows any other as the Bureau wrote it', () => {
    expect(labelFor(MEMORY_COPY.trust, 'verified')).toBe(MEMORY_COPY.trust.verified);
    expect(labelFor(MEMORY_COPY.trust, 'quarantined-by-a-newer-bureau')).toBe(
      'quarantined-by-a-newer-bureau',
    );
  });
});

describe('formatMemoryTime', () => {
  test('is the reader’s locale for a date, and the Bureau’s own text for anything else', () => {
    expect(formatMemoryTime(MEMORY.createdAt)).toBe(new Date(MEMORY.createdAt).toLocaleString());
    expect(formatMemoryTime('last Tuesday')).toBe('last Tuesday');
  });
});

describe('lineageFields', () => {
  const hold = MEMORY_COPY.detail.legalHold.unknown;
  const none: MemoryLineage = { runId: null, corrects: null, correctedBy: null };
  const byId = (fields: ReturnType<typeof lineageFields>) =>
    Object.fromEntries(fields.map((field) => [field.id, field]));

  test('lists the nine fields in the order the page shows them', () => {
    const fields = lineageFields(MEMORY, { runId: 'run-7', corrects: 'a', correctedBy: 'b' }, hold);
    expect(fields.map((field) => field.id)).toEqual([
      'source',
      'trust',
      'class',
      'created',
      'session',
      'run',
      'corrects',
      'corrected-by',
      'legal-hold',
    ]);
    expect(fields.map((field) => field.term)).toEqual([
      MEMORY_COPY.detail.fields.source,
      MEMORY_COPY.detail.fields.trust,
      MEMORY_COPY.detail.fields.memoryClass,
      MEMORY_COPY.detail.fields.created,
      MEMORY_COPY.detail.fields.session,
      MEMORY_COPY.detail.fields.run,
      MEMORY_COPY.detail.fields.corrects,
      MEMORY_COPY.detail.fields.correctedBy,
      MEMORY_COPY.detail.fields.legalHold,
    ]);
  });

  test('takes the source, trust, class, time and chat from the memory, and links the chat', () => {
    const fields = byId(lineageFields(MEMORY, none, hold));
    expect(fields['source']?.value).toBe(MEMORY_COPY.source.conversation);
    expect(fields['trust']?.value).toBe(MEMORY_COPY.trust.untrusted);
    expect(fields['class']?.value).toBe(MEMORY_COPY.memoryClass.episodic);
    expect(fields['created']?.value).toBe(formatMemoryTime(MEMORY.createdAt));
    expect(fields['session']).toMatchObject({
      value: MEMORY_COPY.detail.openChat,
      link: { kind: 'chat', sessionId: 'session-1' },
    });
  });

  test('takes the run and the two corrections from the ledger, and links each correction', () => {
    const fields = byId(
      lineageFields(
        MEMORY,
        { runId: 'run-7', corrects: 'memory-0', correctedBy: 'memory-2' },
        hold,
      ),
    );
    expect(fields['run']).toEqual({
      id: 'run',
      term: MEMORY_COPY.detail.fields.run,
      value: 'run-7',
    });
    expect(fields['corrects']?.link).toEqual({ kind: 'memory', id: 'memory-0' });
    expect(fields['corrected-by']?.link).toEqual({ kind: 'memory', id: 'memory-2' });
  });

  test('says a field was not recorded, with no link, when the Bureau has nothing for it', () => {
    const fields = byId(lineageFields({ ...MEMORY, sessionId: null }, none, hold));
    for (const id of ['session', 'run', 'corrects', 'corrected-by']) {
      expect(fields[id]?.value).toBe(MEMORY_COPY.detail.notRecorded);
      expect(fields[id]?.link).toBeUndefined();
    }
  });

  test('carries the words for what is known of a legal hold', () => {
    const held = MEMORY_COPY.detail.legalHold.held;
    expect(byId(lineageFields(MEMORY, none, held))['legal-hold']?.value).toBe(held);
  });
});
