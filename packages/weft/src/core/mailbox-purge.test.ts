/**
 * `Mailbox.purge` (COR-1934): a host that retires a resource must be able to forget what was sent
 * to it, payloads included, without waiting for terminal retention, and without touching another
 * mailbox of the same storage.
 */

import { describe, expect, it } from 'bun:test';

import { collectKeys } from '../testing/storage-backends.test-support.ts';

import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { ApplicationCommandValidationError } from './mailbox-validation.ts';
import { admitOne, claimOne, createMailboxFixture } from './mailbox.test-support.ts';

const SECRET = 'PAYLOAD-SENTINEL-42';

async function everythingStored(storage: MemoryStorage): Promise<string> {
  const parts: string[] = [];
  for (const key of await collectKeys(storage, '')) {
    parts.push(key, Buffer.from((await storage.get(key)) ?? new Uint8Array()).toString('latin1'));
  }
  return parts.join('\n');
}

describe('Mailbox.purge', () => {
  it('removes every key family of a mailbox with open, claimed and terminal commands, payloads included', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    const payload = { form: 'inline', value: { text: SECRET } } as const;
    await admitOne(mailbox, { payload, idempotencyKey: 'first' });
    await admitOne(mailbox, { payload, idempotencyKey: 'second' });
    await admitOne(mailbox, { payload, idempotencyKey: 'third' });
    // One command settles, one stays claimed, one stays open.
    const settled = await claimOne(mailbox);
    await mailbox.acknowledge({ commandId: settled.commandId, attemptToken: settled.attemptToken });
    await claimOne(mailbox);
    expect(await everythingStored(storage)).toContain(SECRET);
    const stored = await collectKeys(storage, '');
    const families = new Set(stored.map((key) => key.split(':')[0]));
    expect([...families]).toEqual(
      expect.arrayContaining(['appcmd', 'appidem', 'appmbx', 'appready', 'appseq', 'appterm']),
    );

    const deleted = await mailbox.purge();

    expect(deleted).toBeGreaterThan(0);
    expect(await collectKeys(storage, '')).toEqual([]);
    mailbox.dispose();
  });

  it('leaves another mailbox of the same storage, and one whose resource id extends this one, alone', async () => {
    const storage = new MemoryStorage();
    const purged = createMailboxFixture({ storage, resourceId: 'session-1' });
    const neighbour = createMailboxFixture({ storage, resourceId: 'session-10' });
    const other = createMailboxFixture({ storage, resourceId: 'session-2' });
    for (const { mailbox } of [purged, neighbour, other]) {
      await admitOne(mailbox, { payload: { form: 'inline', value: { text: SECRET } } });
    }
    const allKeys = await collectKeys(storage, '');
    const neighbourKeys = allKeys.filter((key) => key.includes('session-10'));
    expect(neighbourKeys.length).toBeGreaterThan(0);

    await purged.mailbox.purge();

    const left = await collectKeys(storage, '');
    expect(left.filter((key) => key.includes('session-1:'))).toEqual([]);
    expect(left.filter((key) => key.includes('session-10'))).toEqual(neighbourKeys);
    expect(left.filter((key) => key.includes('session-2')).length).toBeGreaterThan(0);
    for (const { mailbox } of [purged, neighbour, other]) mailbox.dispose();
  });

  it('answers 0 for a mailbox that holds nothing and when repeated, and can be admitted to again', async () => {
    const storage = new MemoryStorage();
    const { mailbox } = createMailboxFixture({ storage });
    expect(await mailbox.purge()).toBe(0);
    await admitOne(mailbox);
    expect(await mailbox.purge()).toBeGreaterThan(0);
    expect(await mailbox.purge()).toBe(0);
    const again = await admitOne(mailbox);
    const receipt = await mailbox.receipt(again);
    expect(receipt?.sequence).toBe(0);
    mailbox.dispose();
  });

  it('refuses a disposed handle', async () => {
    const { mailbox } = createMailboxFixture();
    mailbox.dispose();
    expect(await rejectionOf(mailbox.purge())).toBeInstanceOf(ApplicationCommandValidationError);
  });
});
