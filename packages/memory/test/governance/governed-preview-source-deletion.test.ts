import { describe, expect, it } from 'bun:test';

import {
  authority,
  createGovernedFixture,
  principalA,
  principalB,
  recordIdOf,
} from './governed-memory-harness';

/** Every entry the durable store holds, so two reads of it compare. */
async function entriesOf(durable: {
  scan(prefix: string): AsyncIterable<[string, Uint8Array]>;
}): Promise<string[]> {
  const entries: string[] = [];
  for await (const [key, value] of durable.scan('')) {
    entries.push(`${key}=${Buffer.from(value).toString('hex')}`);
  }
  return entries.toSorted();
}

describe('previewSourceDeletion', () => {
  const at = (id: string) => ({ id, collection: 'prefs' });

  async function withRecord() {
    const fixture = await createGovernedFixture('in-memory');
    const id = await recordIdOf(
      fixture.memory.write(principalA, 'The user likes jazz music.', {
        collection: 'prefs',
        source: 'conversation',
      }),
    );
    return { fixture, id };
  }

  it('says a source record would be deleted, and changes nothing: no receipt, no event, no removal', async () => {
    const { fixture, id } = await withRecord();
    const before = await entriesOf(fixture.durable);
    const notified = fixture.notifications.length;

    const preview = await fixture.memory.previewSourceDeletion(principalA, at(id));

    expect(preview).toEqual({ outcome: 'would-delete', recordIds: [id] });
    expect(await entriesOf(fixture.durable)).toEqual(before);
    expect(fixture.notifications).toHaveLength(notified);
    expect(await fixture.memory.get(principalA, at(id))).toMatchObject({ id });

    // The deletion it previewed then does happen, so the preview left nothing out of the real path.
    const deleted = await fixture.memory.forget(principalA, {
      mode: 'source-deletion',
      locator: at(id),
    });
    expect(deleted.status).toBe('applied');
  });

  it('refuses what the deletion refuses: a missing record and another owner’s are not-found', async () => {
    const { fixture, id } = await withRecord();
    const before = await entriesOf(fixture.durable);

    expect(await fixture.memory.previewSourceDeletion(principalA, at('missing'))).toEqual({
      outcome: 'refused',
      status: 'not-found',
    });
    expect(await fixture.memory.previewSourceDeletion(principalB, at(id))).toEqual({
      outcome: 'refused',
      status: 'not-found',
    });
    expect(await entriesOf(fixture.durable)).toEqual(before);
    expect(
      await fixture.memory.forget(principalB, { mode: 'source-deletion', locator: at(id) }),
    ).toMatchObject({ status: 'not-found' });
  });

  it('refuses a caller without the delete capability as denied, and records no denial event', async () => {
    const { fixture, id } = await withRecord();
    const reader = authority({ capabilities: ['memory:get'] });
    const before = await entriesOf(fixture.durable);
    const notified = fixture.notifications.length;

    expect(await fixture.memory.previewSourceDeletion(reader, at(id))).toEqual({
      outcome: 'refused',
      status: 'denied',
    });
    expect(await entriesOf(fixture.durable)).toEqual(before);
    expect(fixture.notifications).toHaveLength(notified);

    // The real refusal does record the denial, which is what the preview leaves out.
    expect(
      await fixture.memory.forget(reader, { mode: 'source-deletion', locator: at(id) }),
    ).toMatchObject({ status: 'denied' });
    expect(await entriesOf(fixture.durable)).not.toEqual(before);
  });

  it('refuses a record derived from others as not-source-evidence, as the deletion does', async () => {
    const { fixture, id } = await withRecord();
    const promoted = await fixture.memory.promote(principalA, at(id));
    const shared = { id: promoted.sharedId!, collection: 'prefs', visibility: 'shared' as const };

    const preview = await fixture.memory.previewSourceDeletion(principalA, shared);
    const real = await fixture.memory.forget(principalA, {
      mode: 'source-deletion',
      locator: shared,
    });

    expect(preview).toEqual({
      outcome: 'refused',
      status: 'rejected',
      reason: 'not-source-evidence',
    });
    expect(real).toMatchObject({ status: 'rejected', reason: 'not-source-evidence' });
  });
});
