/**
 * COR-2522 — `bureau.agents.definitions.delete` and `bureau.agents.disable` with `dryRun: true`.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  dryRunResultOf,
  expectNothingWritten,
  expectSameFaultAsTheRealCall,
} from './dry-run.test-support.ts';
import { disposeServed, seed, serve } from './agent-definitions-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';

afterEach(disposeServed);

/** A Bureau over an agent directory: `researcher` is a file agent that has been run once. */
async function served() {
  const storage = new MemoryStorage();
  const harness = await serve({ overrides: { storage } });
  const hash = await seed(harness);
  return {
    harness,
    hash,
    handler: harness.keyed,
    subject: { bureau: harness.bureau, storage, directory: harness.directory },
  };
}

/** The schedule an operator creates for `researcher`: one the agent's removal would leave without it. */
async function scheduleFor(handler: Awaited<ReturnType<typeof served>>['handler']) {
  const created = await rpc(
    handler,
    'bureau.schedules.create',
    { agentName: 'researcher', spec: '1h', input: 'a report' },
    'operator-key',
  );
  expect(created.error).toBeUndefined();
}

describe('bureau.agents.definitions.delete with dryRun', () => {
  it('counts the schedules, goals and open chats that name the agent, and removes nothing', async () => {
    const { harness, hash, handler, subject } = await served();
    await scheduleFor(handler);

    const body = await expectNothingWritten(subject, () =>
      rpc(
        handler,
        'bureau.agents.definitions.delete',
        { id: 'researcher', expectedHash: hash, dryRun: true },
        'agents-writer-key',
      ),
    );

    expect(dryRunResultOf(body)).toEqual({
      dryRun: true,
      target: { kind: 'agent', id: 'researcher' },
      effects: [
        { kind: 'schedules', count: 1 },
        { kind: 'goals', count: 0 },
        { kind: 'open-chats', count: 1 },
      ],
    });
    expect(harness.bureau.agents.list().some((listing) => listing.id === 'researcher')).toBe(true);

    // The real call then deletes the file, and the agent is gone.
    const real = await rpc(
      handler,
      'bureau.agents.definitions.delete',
      { id: 'researcher', expectedHash: hash },
      'agents-writer-key',
    );
    expect(real.error).toBeUndefined();
    expect(harness.bureau.agents.list().some((listing) => listing.id === 'researcher')).toBe(false);
  });

  it('answers the fault the real call answers for an agent that is missing, at another hash, code-defined or not the caller’s', async () => {
    const { hash, handler } = await served();
    const served_ = { handler };
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.definitions.delete',
      { id: 'no-such-agent', expectedHash: hash },
      'agents-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.definitions.delete',
      { id: 'researcher', expectedHash: 'a-hash-the-file-does-not-hold' },
      'agents-writer-key',
    );
    // `alpha` is code-defined: its key is answered NotFound before any file is read.
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.definitions.delete',
      { id: 'alpha', expectedHash: hash },
      'agents-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.definitions.delete',
      { id: 'researcher', expectedHash: hash },
      'alice-key',
    );
    const stale = await rpc(
      handler,
      'bureau.agents.definitions.delete',
      { id: 'researcher', expectedHash: 'a-hash-the-file-does-not-hold', dryRun: true },
      'agents-writer-key',
    );
    expect(stale.error?.data).toMatchObject({ weftCode: 'StaleRevision', currentRevision: hash });
  });
});

describe('bureau.agents.disable with dryRun', () => {
  it('counts what names the agent, writes nothing and leaves the agent enabled', async () => {
    const { harness, handler, subject } = await served();
    await scheduleFor(handler);

    const body = await expectNothingWritten(subject, () =>
      rpc(
        handler,
        'bureau.agents.disable',
        { id: 'researcher', dryRun: true },
        'agents-writer-key',
      ),
    );

    expect(dryRunResultOf(body)).toEqual({
      dryRun: true,
      target: { kind: 'agent', id: 'researcher' },
      effects: [
        { kind: 'schedules', count: 1 },
        { kind: 'goals', count: 0 },
        { kind: 'open-chats', count: 1 },
      ],
    });
    expect(harness.bureau.agents.isDisabled('researcher')).toBe(false);

    // The real call then disables it.
    const real = await rpc(
      handler,
      'bureau.agents.disable',
      { id: 'researcher' },
      'agents-writer-key',
    );
    expect(real.result).toEqual({ id: 'researcher', disabled: true });
    expect(harness.bureau.agents.isDisabled('researcher')).toBe(true);
  });

  it('answers the fault the real call answers for an agent that is missing or not the caller’s', async () => {
    const { handler } = await served();
    const served_ = { handler };
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.disable',
      { id: 'no-such-agent' },
      'agents-writer-key',
    );
    await expectSameFaultAsTheRealCall(
      served_,
      'bureau.agents.disable',
      { id: 'researcher' },
      'alice-key',
    );
  });
});
