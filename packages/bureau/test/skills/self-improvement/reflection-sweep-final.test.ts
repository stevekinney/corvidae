import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it, mock } from 'bun:test';

import type { IdentityProviderLike } from '../../../src/skills/self-improvement/proposals';
import {
  getProposal,
  listProposals,
  rejectProposal,
} from '../../../src/skills/self-improvement/proposals';
import { reflectionSweep } from '../../../src/skills/self-improvement/reflection-sweep';
import type { StepResultLike } from '../../../src/skills/skill-memory';
import { createMockKeyValueStore, createMockSkillProvider } from '../../../src/skills/test';

function createMockIdentityProvider(): IdentityProviderLike & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async savePendingSoulUpdate(items: unknown[], agentId?: string): Promise<void> {
      calls.push({ method: 'savePendingSoulUpdate', args: [items, agentId] });
    },
    async savePersona(agentId: string, persona: { text?: string }): Promise<void> {
      calls.push({ method: 'savePersona', args: [agentId, persona] });
    },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function createMockConversation(messages: Array<{ role: string; content: string }>) {
  return {
    getMessages() {
      return messages;
    },
  };
}

function createStepResult(overrides?: Partial<StepResultLike>): StepResultLike {
  return {
    step: 1,
    conversation: createMockConversation([
      { role: 'user', content: 'Help me refactor the auth module' },
      { role: 'assistant', content: 'I will break the refactor into three steps.' },
      { role: 'user', content: 'Sounds good, proceed.' },
      { role: 'assistant', content: 'Refactoring complete. All tests pass.' },
    ]),
    content: 'Refactoring complete. All tests pass.',
    final: true,
    metadata: {},
    ...overrides,
  };
}

// ── memory sink ───────────────────────────────────────────────────────────────

describe('reflectionSweep — shouldReflect predicate (cross-sink)', () => {
  it('skill sink: honours shouldReflect returning false', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
      shouldReflect: () => false,
    });

    await onStep(createStepResult());

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });

  it('soul sink: honours shouldReflect returning false', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
      shouldReflect: () => false,
    });

    await onStep(createStepResult());

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});
describe('reflectionSweep — rejected pattern suppression', () => {
  it('skill sink: does not re-create a proposal when content was previously rejected', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const content = '---\nname: recurring-skill\ndescription: Recurring\n---\n\nDo the thing.';
    const reflect = mock(async () => content);

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    // First sweep: proposal created.
    await onStep(createStepResult());
    const firstBatch = await listProposals(storage);
    expect(firstBatch).toHaveLength(1);

    // Human rejects the proposal.
    await rejectProposal(storage, firstBatch[0]!.id, 'Not relevant');

    // Second sweep with identical content: should be suppressed.
    await onStep(createStepResult());
    const secondBatch = await listProposals(storage);
    // Pending count must remain 0 — the rejected proposal is status:'rejected', not pending.
    expect(secondBatch).toHaveLength(0);
  });

  it('soul sink: does not re-create a proposal when content was previously rejected', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const content = JSON.stringify([{ id: 'item-1', content: 'Be concise' }]);
    const reflect = mock(async () => content);

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
    });

    await onStep(createStepResult());
    const firstBatch = await listProposals(storage);
    expect(firstBatch).toHaveLength(1);

    await rejectProposal(storage, firstBatch[0]!.id);

    await onStep(createStepResult());
    const secondBatch = await listProposals(storage);
    expect(secondBatch).toHaveLength(0);
  });

  it('persona sink: does not re-create a proposal when content was previously rejected', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const content = 'You are a concise assistant.';
    const reflect = mock(async () => content);

    const { onStep } = reflectionSweep({
      sink: { type: 'persona', storage, identityProvider, agentId: 'agent-x' },
      reflect,
    });

    await onStep(createStepResult());
    const firstBatch = await listProposals(storage);
    expect(firstBatch).toHaveLength(1);

    await rejectProposal(storage, firstBatch[0]!.id);

    await onStep(createStepResult());
    const secondBatch = await listProposals(storage);
    expect(secondBatch).toHaveLength(0);
  });

  it('allows a new proposal when the reflected content differs from the rejected hash', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    let callCount = 0;
    const reflect = mock(async () => {
      callCount++;
      return `content-${callCount}`;
    });

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    // First sweep: proposal with 'content-1'.
    await onStep(createStepResult());
    const firstBatch = await listProposals(storage);
    expect(firstBatch).toHaveLength(1);
    await rejectProposal(storage, firstBatch[0]!.id);

    // Second sweep: different content ('content-2') must still be proposed.
    await onStep(createStepResult());
    const secondBatch = await listProposals(storage);
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0]!.content).toBe('content-2');
  });
});
describe('reflectionSweep — proposal field integrity', () => {
  it('proposal has a unique id, createdAt, and empty sourceEntryIds', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    const proposal = proposals[0]!;
    expect(proposal.id).toBeTruthy();
    expect(proposal.createdAt).toBeTruthy();
    expect(new Date(proposal.createdAt).getTime()).not.toBeNaN();
    expect(proposal.sourceEntryIds).toEqual([]);
  });

  it('each call produces a distinct proposal id', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());
    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]!.id).not.toBe(proposals[1]!.id);
  });

  it('can retrieve the created proposal by id', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill proposal content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    const id = proposals[0]!.id;
    const retrieved = await getProposal(storage, id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe('skill proposal content');
  });

  it('derives id and createdAt from an injected manual runtime', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');
    const runtime = createManualRuntimeServices({
      origin: '2026-03-01T00:00:00.000Z',
      identifierSeed: 'proposal-seed',
    });

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
      runtime,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    const proposal = proposals[0]!;
    expect(proposal.id).toBe(`${runtime.identifierPrefix}-skill-1`);
    expect(proposal.createdAt).toBe('2026-03-01T00:00:00.000Z');
  });
});
