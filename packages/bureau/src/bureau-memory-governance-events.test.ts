/**
 * COR-1723 — a governed memory handed to the Bureau reports its notifications on the bureau
 * emitter as `memory.governance`, and stops when the Bureau shuts down.
 */
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryAuthority,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMockEmbedder,
  type GovernedMemory,
  type MemoryGovernanceNotification,
} from '@lostgradient/memory';
import { MemoryStorage } from '@lostgradient/weft';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { projectBureauEvent } from './bureau-event-feed';
import { forwardMemoryGovernance } from './bureau-event-forwarders';
import { createBureau } from './create-bureau';
import { MemoryGovernanceEvent } from './events';
import { agentFileDirectory } from './sources/agent-file-directory';
import { startFileBureau } from './testing/agent-file-bureau.test-support';
import type { BureauDiagnostic } from './types';

const SECRET = 'SECRET-record-content-4417';

function governedMemory(): GovernedMemory {
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: 'governance:cor-1723' }),
  });
}

const writer = createMemoryAuthority({
  principal: { kind: 'user', id: 'user:alice' },
  tenantId: 'bureau',
  ownerId: 'alice',
  purpose: 'cor-1723',
  capabilities: ['memory:write', 'memory:list'],
  policyRevision: 'authorization:1',
  projection: 'bureau',
});

const note = { collection: 'prefs', source: 'conversation' } as const;

describe('memory.governance on the bureau emitter', () => {
  it('forwards each notification of a supplied memory, with identifiers only, and stops at shutdown', async () => {
    const base = governedMemory();
    let unsubscribed = 0;
    const memory: GovernedMemory = {
      ...base,
      subscribe(listener) {
        const stop = base.subscribe(listener);
        return () => {
          unsubscribed += 1;
          stop();
        };
      },
    };
    const heard: MemoryGovernanceNotification[] = [];
    base.subscribe((notification) => void heard.push(notification));
    const seen: MemoryGovernanceEvent[] = [];
    const bureau = await createBureau<AgentDefinitions>({
      id: 'bureau',
      agents: {},
      memory,
      onEvent: (event) => {
        if (event instanceof MemoryGovernanceEvent) seen.push(event);
      },
    });

    const receipt = await memory.write(writer, SECRET, note);
    expect(receipt.status).toBe('admitted');

    expect(heard.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(heard.length);
    const admitted = seen.find((event) => event.notificationType === 'memory.write.admitted');
    expect(admitted).toMatchObject({
      type: 'memory.governance',
      outcome: 'admitted',
      tenantId: 'bureau',
      recordIds: [receipt.recordId],
    });
    expect(typeof admitted?.at).toBe('number');
    expect(typeof admitted?.operationId).toBe('string');
    const projection = projectBureauEvent(admitted);
    expect(projection?.kind).toBe('memory.governance');
    expect(Object.keys(projection?.payload ?? {}).toSorted()).toEqual([
      'at',
      'operationId',
      'outcome',
      'recordIds',
      'tenantId',
      'type',
    ]);
    expect(JSON.stringify(projection)).not.toContain(SECRET);
    expect(JSON.stringify(admitted)).not.toContain(SECRET);

    expect(unsubscribed).toBe(0);
    await bureau.shutdown();
    expect(unsubscribed).toBe(1);
    const afterShutdown = seen.length;
    await base.write(writer, 'Written after shutdown.', note);
    expect(seen).toHaveLength(afterShutdown);
  });

  it('leaves nothing subscribed on a memory when construction fails after forwarding began', async () => {
    const base = governedMemory();
    let active = 0;
    const memory: GovernedMemory = {
      ...base,
      subscribe(listener) {
        const stop = base.subscribe(listener);
        active += 1;
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          active -= 1;
          stop();
        };
      },
    };
    const seen: Event[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'bureau-memory-governance-'));
    // The source fails when the catalog starts watching, which runs after the memory forwarder is subscribed.
    const failing = Object.assign(agentFileDirectory(directory), {
      watch: () => {
        throw new Error('watch failed');
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failure = await rejectionOf(
        startFileBureau({
          directory,
          overrides: {
            id: 'bureau',
            memory,
            agentSource: failing,
            onEvent: (event) => void seen.push(event),
          },
        }),
      );
      expect(failure).toBeInstanceOf(Error);
      expect(active).toBe(0);
    }

    const before = seen.length;
    await base.write(writer, 'Written after the failed builds.', note);
    expect(seen.filter((event) => event instanceof MemoryGovernanceEvent)).toHaveLength(0);
    expect(seen).toHaveLength(before);
  });

  it('leaves a Bureau without memory alone', async () => {
    const bureau = await createBureau<AgentDefinitions>({ agents: {} });
    await bureau.shutdown();
  });
});

describe('forwardMemoryGovernance', () => {
  it('diagnoses a dispatch that throws, and keeps forwarding', async () => {
    const memory = governedMemory();
    const diagnostics: BureauDiagnostic[] = [];
    let attempts = 0;
    const stop = forwardMemoryGovernance(
      memory,
      () => {
        attempts += 1;
        throw new Error('listener failed');
      },
      (diagnostic) => void diagnostics.push(diagnostic),
    );

    const first = await memory.write(writer, 'One.', note);
    expect(first.status).toBe('admitted');
    expect(attempts).toBeGreaterThan(0);
    expect(diagnostics).toHaveLength(attempts);
    expect(diagnostics[0]).toMatchObject({ level: 'error', scope: 'events' });

    stop();
    await memory.write(writer, 'Two.', note);
    expect(diagnostics).toHaveLength(attempts);
  });
});
