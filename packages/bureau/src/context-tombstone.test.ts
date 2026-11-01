/**
 * COR-1986 — the context tombstone: its key, its four-field record, and the rule that the first
 * record written stands.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  CONTEXT_TOMBSTONE_PREFIX,
  type ContextTombstone,
  contextTombstoneKey,
  parseContextTombstone,
  readContextTombstone,
  writeContextTombstone,
} from './context-tombstone.ts';

const open = () => textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });

describe('a context tombstone', () => {
  it('is keyed by the encoded context id under its own prefix', () => {
    expect(contextTombstoneKey('thread/1')).toStartWith(CONTEXT_TOMBSTONE_PREFIX);
    expect(contextTombstoneKey('thread/1')).not.toContain('thread/1');
    expect(contextTombstoneKey('a')).not.toBe(contextTombstoneKey('b'));
  });

  it('is written and read back with exactly four fields', async () => {
    const kv = open();
    await writeContextTombstone(kv, {
      version: 1,
      contextId: 'thread-1',
      owner: 'alice',
      deletedAt: 1_000,
    });

    expect(await readContextTombstone(kv, 'thread-1')).toEqual({
      version: 1,
      contextId: 'thread-1',
      owner: 'alice',
      deletedAt: 1_000,
    });
    const stored = await kv.get(contextTombstoneKey('thread-1'));
    expect(Object.keys(JSON.parse(stored!) as object).toSorted()).toEqual([
      'contextId',
      'deletedAt',
      'owner',
      'version',
    ]);
  });

  it('keeps the first record when a second is written', async () => {
    const kv = open();
    await writeContextTombstone(kv, { version: 1, contextId: 't', owner: 'alice', deletedAt: 1 });
    await writeContextTombstone(kv, { version: 1, contextId: 't', owner: 'bob', deletedAt: 2 });

    expect(await readContextTombstone(kv, 't')).toEqual({
      version: 1,
      contextId: 't',
      owner: 'alice',
      deletedAt: 1,
    });
  });

  it('records a null owner', async () => {
    const kv = open();
    await writeContextTombstone(kv, { version: 1, contextId: 't', owner: null, deletedAt: 5 });

    expect(await readContextTombstone(kv, 't')).toMatchObject({ owner: null });
  });

  it('reads as undefined when none was written, and as unreadable when the record is not one', async () => {
    const kv = open();
    expect(await readContextTombstone(kv, 'missing')).toBeUndefined();

    await kv.set(contextTombstoneKey('odd'), 'not json');
    expect(await readContextTombstone(kv, 'odd')).toBe('unreadable');
  });

  it('parses only its own version and shape', () => {
    const good: ContextTombstone = { version: 1, contextId: 't', owner: null, deletedAt: 3 };
    expect(parseContextTombstone(JSON.stringify(good))).toEqual(good);
    expect(parseContextTombstone(JSON.stringify({ ...good, version: 2 }))).toBeUndefined();
    expect(parseContextTombstone(JSON.stringify({ ...good, owner: 7 }))).toBeUndefined();
    expect(parseContextTombstone(JSON.stringify({ ...good, deletedAt: 'x' }))).toBeUndefined();
    expect(parseContextTombstone('null')).toBeUndefined();
    expect(parseContextTombstone('{')).toBeUndefined();
  });
});
