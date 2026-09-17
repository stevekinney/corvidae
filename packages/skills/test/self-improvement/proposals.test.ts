import { describe, expect, it } from 'bun:test';

import type { IdentityProviderLike } from '../../src/self-improvement/proposals';
import {
  acceptProposal,
  getProposal,
  listProposals,
  saveProposal,
} from '../../src/self-improvement/proposals';
import { createMockKeyValueStore, createMockSkillProvider } from '../../src/test';
import type { Proposal } from '../../src/types';

// Fixed instant standing in for a proposal's createdAt below — saveProposal persists whatever
// the caller provides verbatim, so a stable value is all these fixtures need.
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';
let nextProposalId = 0;

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: overrides.id ?? `test-proposal-${nextProposalId++}`,
    type: 'skill',
    summary: 'Test proposal',
    content: '---\nname: test-skill\ndescription: A test skill\n---\n\nDo the thing.',
    sourceEntryIds: ['entry-1'],
    createdAt: FIXED_CREATED_AT,
    status: 'pending',
    ...overrides,
  };
}

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

describe('proposals', () => {
  describe('saveProposal and getProposal', () => {
    it('round-trips a proposal through storage', async () => {
      const storage = createMockKeyValueStore();
      const proposal = makeProposal({ id: 'proposal-1' });

      await saveProposal(storage, proposal);
      const retrieved = await getProposal(storage, 'proposal-1');

      expect(retrieved).toEqual(proposal);
    });

    it('returns undefined for a non-existent proposal', async () => {
      const storage = createMockKeyValueStore();
      const result = await getProposal(storage, 'does-not-exist');

      expect(result).toBeUndefined();
    });

    it('returns undefined for malformed proposal JSON', async () => {
      const storage = createMockKeyValueStore();
      await storage.set('proposal:broken', '{not valid json');

      const result = await getProposal(storage, 'broken');

      expect(result).toBeUndefined();
    });
  });

  describe('listProposals', () => {
    it('returns all pending proposals by default', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'accepted' }));

      const result = await listProposals(storage);

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.id).toSorted()).toEqual(['p1', 'p2']);
    });

    it('filters by type', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'skill-1', type: 'skill' }));
      await saveProposal(storage, makeProposal({ id: 'soul-1', type: 'soul' }));
      await saveProposal(storage, makeProposal({ id: 'persona-1', type: 'persona' }));

      const result = await listProposals(storage, { type: 'soul' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('soul-1');
    });

    it('filters by agentId', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'p1', agentId: 'agent-a' }));
      await saveProposal(storage, makeProposal({ id: 'p2', agentId: 'agent-b' }));
      await saveProposal(storage, makeProposal({ id: 'p3' }));

      const result = await listProposals(storage, { agentId: 'agent-a' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('p1');
    });

    it('filters by status', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'p1', status: 'pending' }));
      await saveProposal(storage, makeProposal({ id: 'p2', status: 'accepted' }));
      await saveProposal(storage, makeProposal({ id: 'p3', status: 'rejected' }));

      const result = await listProposals(storage, { status: 'rejected' });

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('p3');
    });

    it('skips malformed proposals while listing', async () => {
      const storage = createMockKeyValueStore();

      await saveProposal(storage, makeProposal({ id: 'valid-proposal', status: 'pending' }));
      await storage.set('proposal:broken', '{not valid json');

      const result = await listProposals(storage);

      expect(result.map((proposal) => proposal.id)).toEqual(['valid-proposal']);
    });
  });

  describe('acceptProposal', () => {
    it('accepts a skill proposal and writes to skill provider', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'skill-proposal',
        type: 'skill',
        content: '---\nname: test-skill\ndescription: A test skill\n---\n\nDo the thing.',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'skill-proposal', { skillProvider });

      expect(result.accepted).toBe(true);

      const saveCalls = skillProvider.calls.filter((c) => c.method === 'saveSkill');
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]!.args[0]!).toBe('test-skill');
    });

    it('sets the proposal status to accepted', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({ id: 'accept-me', type: 'skill' });
      await saveProposal(storage, proposal);

      await acceptProposal(storage, 'accept-me', { skillProvider });

      const updated = await getProposal(storage, 'accept-me');
      expect(updated?.status).toBe('accepted');
    });

    it('accepts a soul proposal and calls savePendingSoulUpdate', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const soulItems = [{ id: 'item-1', content: 'Be helpful' }];
      const proposal = makeProposal({
        id: 'soul-proposal',
        type: 'soul',
        content: JSON.stringify(soulItems),
        agentId: 'agent-x',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'soul-proposal', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(true);

      const soulCalls = identityProvider.calls.filter((c) => c.method === 'savePendingSoulUpdate');
      expect(soulCalls).toHaveLength(1);
      expect(soulCalls[0]!.args[0]!).toEqual(soulItems);
      expect(soulCalls[0]!.args[1]!).toBe('agent-x');
    });

    it('accepts a persona proposal and calls savePersona', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const proposal = makeProposal({
        id: 'persona-proposal',
        type: 'persona',
        content: 'You are a friendly assistant.',
        agentId: 'agent-y',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-proposal', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(true);

      const personaCalls = identityProvider.calls.filter((c) => c.method === 'savePersona');
      expect(personaCalls).toHaveLength(1);
      expect(personaCalls[0]!.args[0]!).toBe('agent-y');
      expect(personaCalls[0]!.args[1]!).toEqual({ text: 'You are a friendly assistant.' });
    });

    it('returns an error for a non-existent proposal', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();

      const result = await acceptProposal(storage, 'nope', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns an error for a soul proposal without identityProvider', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'soul-no-identity',
        type: 'soul',
        content: JSON.stringify([{ id: 'item-1', content: 'Be helpful' }]),
        agentId: 'agent-x',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'soul-no-identity', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Identity provider required for soul proposals.');
    });

    it('returns an error for invalid soul proposal JSON arrays', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const proposal = makeProposal({
        id: 'invalid-soul-json',
        type: 'soul',
        content: '{"not":"an-array"}',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'invalid-soul-json', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Soul proposal content is not a valid JSON array.');
    });

    it('returns an error for a persona proposal without identityProvider', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const proposal = makeProposal({
        id: 'persona-no-identity',
        type: 'persona',
        content: 'You are a helpful assistant.',
        agentId: 'agent-y',
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-no-identity', { skillProvider });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Identity provider required for persona proposals.');
    });

    it('returns an error for a persona proposal without agentId', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      const identityProvider = createMockIdentityProvider();
      const proposal = makeProposal({
        id: 'persona-no-agent',
        type: 'persona',
        content: 'You are a helpful assistant.',
        // no agentId
      });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'persona-no-agent', {
        skillProvider,
        identityProvider,
      });

      expect(result.accepted).toBe(false);
      expect(result.error).toBe('Persona proposals require an agentId.');
    });

    it('returns underlying provider errors when acceptance throws', async () => {
      const storage = createMockKeyValueStore();
      const skillProvider = createMockSkillProvider();
      skillProvider.saveSkill = async () => {
        throw new Error('storage write failed');
      };
      const proposal = makeProposal({ id: 'failing-skill-acceptance', type: 'skill' });
      await saveProposal(storage, proposal);

      const result = await acceptProposal(storage, 'failing-skill-acceptance', { skillProvider });

      expect(result).toEqual({
        accepted: false,
        error: 'storage write failed',
      });
    });
  });
});
