import { describe, expect, it, mock } from 'bun:test';

import type { IdentityProviderLike } from '../../src/self-improvement/proposals';
import { listProposals } from '../../src/self-improvement/proposals';
import { reflectionSweep } from '../../src/self-improvement/reflection-sweep';
import type { StepResultLike } from '../../src/skill-memory';
import { createMockKeyValueStore, createMockSkillProvider } from '../../src/test';

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

describe('reflectionSweep — skill sink', () => {
  it('creates a pending skill proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(
      async () => '---\nname: test-skill\ndescription: A new skill\n---\n\nDo the thing.',
    );

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('skill');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toContain('test-skill');
  });

  it('creates a skill proposal with an optional agentId', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => '---\nname: agent-skill\ndescription: Skills\n---\n\nBody.');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider, agentId: 'agent-42' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.agentId).toBe('agent-42');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'content');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });

  it('uses a custom proposalSummary when provided', async () => {
    const storage = createMockKeyValueStore();
    const skillProvider = createMockSkillProvider();
    const reflect = mock(async () => 'skill content');
    const proposalSummary = mock(() => 'Custom summary');

    const { onStep } = reflectionSweep({
      sink: { type: 'skill', storage, skillProvider },
      reflect,
      proposalSummary,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.summary).toBe('Custom summary');
    expect(proposalSummary).toHaveBeenCalledTimes(1);
  });
});
describe('reflectionSweep — soul sink', () => {
  it('creates a pending soul proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const soulContent = JSON.stringify([{ id: 'item-1', content: 'Be helpful' }]);
    const reflect = mock(async () => soulContent);

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('soul');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toBe(soulContent);
  });

  it('creates a soul proposal with an optional agentId', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider, agentId: 'soul-agent' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals[0]!.agentId).toBe('soul-agent');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => '[]');

    const { onStep } = reflectionSweep({
      sink: { type: 'soul', storage, identityProvider },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});
describe('reflectionSweep — persona sink', () => {
  it('creates a pending persona proposal in storage', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => 'You are a meticulous refactoring assistant.');

    const { onStep } = reflectionSweep({
      sink: { type: 'persona', storage, identityProvider, agentId: 'refactor-agent' },
      reflect,
    });

    await onStep(createStepResult());

    const proposals = await listProposals(storage);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.type).toBe('persona');
    expect(proposal.status).toBe('pending');
    expect(proposal.content).toBe('You are a meticulous refactoring assistant.');
    expect(proposal.agentId).toBe('refactor-agent');
  });

  it('is a no-op on non-final steps', async () => {
    const storage = createMockKeyValueStore();
    const identityProvider = createMockIdentityProvider();
    const reflect = mock(async () => 'persona content');

    const { onStep } = reflectionSweep({
      sink: { type: 'persona', storage, identityProvider, agentId: 'agent-x' },
      reflect,
    });

    await onStep(createStepResult({ final: false }));

    expect(reflect).not.toHaveBeenCalled();
    expect(await listProposals(storage)).toHaveLength(0);
  });
});
