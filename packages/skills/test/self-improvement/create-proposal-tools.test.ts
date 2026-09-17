import { describe, expect, it } from 'bun:test';

import { createProposalToolbox } from '../../src/self-improvement/create-proposal-tools';
import { saveProposal } from '../../src/self-improvement/proposals';
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

function setup() {
  const storage = createMockKeyValueStore();
  const skillProvider = createMockSkillProvider();
  const toolbox = createProposalToolbox({ storage, skillProvider });
  return { storage, skillProvider, toolbox };
}

describe('createProposalToolbox', () => {
  describe('listProposals tool', () => {
    it('returns pending proposals', async () => {
      const { storage, toolbox } = setup();

      await saveProposal(storage, makeProposal({ id: 'p1', summary: 'First' }));
      await saveProposal(storage, makeProposal({ id: 'p2', summary: 'Second' }));
      await saveProposal(
        storage,
        makeProposal({ id: 'p3', summary: 'Accepted', status: 'accepted' }),
      );

      const result = await toolbox.listProposals({});
      if (!result || !('proposals' in result)) throw new Error('Expected proposal list result.');

      expect(result.proposals).toHaveLength(2);
    });
  });

  describe('viewProposal tool', () => {
    it('returns full proposal content', async () => {
      const { storage, toolbox } = setup();
      const proposal = makeProposal({ id: 'view-me', summary: 'View this' });
      await saveProposal(storage, proposal);

      const result = await toolbox.viewProposal({ id: 'view-me' });
      if (!result || !('proposal' in result) || !result.proposal) {
        throw new Error('Expected found proposal result.');
      }

      expect(result.found).toBe(true);
      expect(result.proposal.id).toBe('view-me');
      expect(result.proposal.summary).toBe('View this');
    });

    it('handles missing proposals gracefully', async () => {
      const { toolbox } = setup();

      const result = await toolbox.viewProposal({ id: 'nope' });
      if (!result || !('found' in result)) throw new Error('Expected proposal lookup result.');

      expect(result.found).toBe(false);
    });
  });

  describe('acceptProposal tool', () => {
    it('calls acceptProposal and returns confirmation', async () => {
      const { storage, skillProvider, toolbox } = setup();
      const proposal = makeProposal({ id: 'accept-me', type: 'skill' });
      await saveProposal(storage, proposal);

      const result = await toolbox.acceptProposal({ id: 'accept-me' });
      if (!result || !('accepted' in result))
        throw new Error('Expected proposal acceptance result.');

      expect(result.accepted).toBe(true);
      expect(skillProvider.calls.some((c) => c.method === 'saveSkill')).toBe(true);
    });

    it('handles missing proposals gracefully', async () => {
      const { toolbox } = setup();

      const result = await toolbox.acceptProposal({ id: 'nope' });
      if (!result || !('accepted' in result))
        throw new Error('Expected proposal acceptance result.');

      expect(result.accepted).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('rejectProposal tool', () => {
    it('calls rejectProposal with reason and returns confirmation', async () => {
      const { storage, toolbox } = setup();
      const proposal = makeProposal({ id: 'reject-me' });
      await saveProposal(storage, proposal);

      const result = await toolbox.rejectProposal({
        id: 'reject-me',
        reason: 'Not helpful',
      });
      if (!result || !('rejected' in result))
        throw new Error('Expected proposal rejection result.');

      expect(result.rejected).toBe(true);
    });

    it('handles missing proposals gracefully', async () => {
      const { toolbox } = setup();

      const result = await toolbox.rejectProposal({ id: 'nope' });
      if (!result || !('rejected' in result))
        throw new Error('Expected proposal rejection result.');

      expect(result.rejected).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
