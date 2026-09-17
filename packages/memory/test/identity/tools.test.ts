import { describe, expect, it } from 'bun:test';

import { createStaticIdentityProvider } from '../../src/identity/create-static-provider';
import {
  createIdentityToolbox,
  createPersonaCreateTool,
  createPersonaDeleteTool,
  createPersonaListTool,
  createPersonaUpdateTool,
  createPersonaViewTool,
  createSoulAcceptTool,
  createSoulDiffTool,
  createSoulPinTool,
  createSoulRejectTool,
  createSoulViewTool,
} from '../../src/identity/tools';
import type { SoulItem } from '../../src/identity/types';

function makeSoulItem(id: string, content: string, overrides?: Partial<SoulItem>): SoulItem {
  return {
    id,
    content,
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
    ...overrides,
  };
}

describe('Soul Tools', () => {
  describe('soul_diff', () => {
    it('returns structured diff output', async () => {
      const provider = createStaticIdentityProvider({
        soul: [makeSoulItem('1', 'Original')],
      });
      await provider.savePendingSoulUpdate([
        makeSoulItem('1', 'Modified'),
        makeSoulItem('2', 'Added'),
      ]);

      const tool = createSoulDiffTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('empty', false);
      expect(result).toHaveProperty('additions.length', 1);
      expect(result).toHaveProperty('modifications.length', 1);
    });

    it('handles no pending update gracefully', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createSoulDiffTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('empty', true);
    });
  });

  describe('soul_accept', () => {
    it('accepts the pending update', async () => {
      const provider = createStaticIdentityProvider({
        soul: [makeSoulItem('1', 'V1')],
      });
      await provider.savePendingSoulUpdate([makeSoulItem('1', 'V2')]);

      const tool = createSoulAcceptTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('accepted', true);
      expect(result).toHaveProperty('version', expect.any(Number));
    });

    it('returns not accepted when no pending update', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createSoulAcceptTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('accepted', false);
    });
  });

  describe('soul_reject', () => {
    it('rejects the pending update', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePendingSoulUpdate([makeSoulItem('1', 'Pending')]);

      const tool = createSoulRejectTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('rejected', true);
      expect(await provider.loadPendingSoulUpdate()).toBeUndefined();
    });
  });

  describe('soul_pin', () => {
    it('pins a soul item', async () => {
      const provider = createStaticIdentityProvider({
        soul: [makeSoulItem('1', 'Item', { pinned: false })],
      });

      const tool = createSoulPinTool(provider);
      const result = await tool({ itemId: '1', pinned: true });

      expect(result).toHaveProperty('success', true);
      const soul = await provider.loadSoul();
      expect(soul[0]!.pinned).toBe(true);
    });

    it('returns failure for non-existent item', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createSoulPinTool(provider);
      const result = await tool({ itemId: 'nonexistent', pinned: true });

      expect(result).toHaveProperty('success', false);
    });
  });

  describe('soul_view', () => {
    it('returns the current soul items and rendered text', async () => {
      const provider = createStaticIdentityProvider({
        soul: [makeSoulItem('1', 'Be helpful.')],
        userContext: 'User prefers dark mode.',
      });

      const tool = createSoulViewTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('items.length', 1);
      expect(result).toHaveProperty('rendered', expect.stringContaining('Be helpful.'));
      expect(result).toHaveProperty('rendered', expect.stringContaining('User prefers dark mode.'));
    });
  });
});

describe('Persona Tools', () => {
  describe('persona_list', () => {
    it('returns all registered personas with descriptors', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePersona('research', {
        descriptor: { name: 'Atlas', role: 'researcher' },
      });
      await provider.savePersona('code', {
        descriptor: { name: 'Forge', role: 'coder' },
      });

      const tool = createPersonaListTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('personas.length', 2);
      expect(result).toHaveProperty(
        'personas',
        expect.arrayContaining([expect.objectContaining({ agentId: 'research' })]),
      );
      expect(result).toHaveProperty(
        'personas',
        expect.arrayContaining([expect.objectContaining({ agentId: 'code' })]),
      );
    });

    it('returns empty array when no personas exist', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createPersonaListTool(provider);
      const result = await tool({});

      expect(result).toHaveProperty('personas', []);
    });
  });

  describe('persona_view', () => {
    it('returns persona details', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePersona('research', {
        descriptor: { name: 'Atlas', role: 'researcher' },
        text: 'Always cite sources.',
      });

      const tool = createPersonaViewTool(provider);
      const result = await tool({ agentId: 'research' });

      expect(result).toHaveProperty('found', true);
      expect(result).toHaveProperty('descriptor.name', 'Atlas');
      expect(result).toHaveProperty('text', 'Always cite sources.');
    });

    it('returns not found for non-existent persona', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createPersonaViewTool(provider);
      const result = await tool({ agentId: 'nonexistent' });

      expect(result).toHaveProperty('found', false);
    });
  });

  describe('persona_create', () => {
    it('creates a new persona', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createPersonaCreateTool(provider);

      const result = await tool({
        agentId: 'research',
        descriptor: { name: 'Atlas', role: 'researcher' },
        text: 'Be thorough.',
      });

      expect(result).toHaveProperty('created', true);

      const persona = await provider.loadPersona('research');
      expect(persona?.descriptor?.name).toBe('Atlas');
      expect(persona?.text).toBe('Be thorough.');
    });

    it('created persona appears in persona_list', async () => {
      const provider = createStaticIdentityProvider();
      const createTool = createPersonaCreateTool(provider);
      const listTool = createPersonaListTool(provider);

      await createTool({
        agentId: 'research',
        descriptor: { name: 'Atlas', role: 'researcher' },
      });

      const result = await listTool({});
      expect(result).toHaveProperty(
        'personas',
        expect.arrayContaining([expect.objectContaining({ agentId: 'research' })]),
      );
    });
  });

  describe('persona_update', () => {
    it('merges partial descriptor with existing', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePersona('research', {
        descriptor: { name: 'Atlas', role: 'researcher' },
        text: 'Original instructions.',
      });

      const tool = createPersonaUpdateTool(provider);
      const result = await tool({
        agentId: 'research',
        descriptor: { expertise: 'web search' },
      });

      expect(result).toHaveProperty('updated', true);

      const persona = await provider.loadPersona('research');
      expect(persona?.descriptor?.name).toBe('Atlas'); // preserved
      expect(persona?.descriptor?.expertise).toBe('web search'); // added
      expect(persona?.text).toBe('Original instructions.'); // preserved
    });

    it('returns not updated for non-existent persona', async () => {
      const provider = createStaticIdentityProvider();
      const tool = createPersonaUpdateTool(provider);
      const result = await tool({
        agentId: 'nonexistent',
        descriptor: { expertise: 'test' },
      });

      expect(result).toHaveProperty('updated', false);
    });

    it('preserves an undefined descriptor when updating a text-only persona', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePersona('scheduler', {
        text: 'Keep responses concise.',
      });

      const tool = createPersonaUpdateTool(provider);
      const result = await tool({
        agentId: 'scheduler',
        descriptor: { expertise: 'scheduling' },
        text: 'Keep responses concise and timezone-aware.',
      });

      expect(result).toHaveProperty('updated', true);

      const persona = await provider.loadPersona('scheduler');
      expect(persona?.descriptor).toBeUndefined();
      expect(persona?.text).toBe('Keep responses concise and timezone-aware.');
    });
  });

  describe('persona_delete', () => {
    it('deletes a persona', async () => {
      const provider = createStaticIdentityProvider();
      await provider.savePersona('research', {
        descriptor: { name: 'Atlas', role: 'researcher' },
      });

      const tool = createPersonaDeleteTool(provider);
      await tool({ agentId: 'research' });

      const personas = await provider.listPersonas();
      expect(personas).toEqual([]);
    });
  });
});

describe('createIdentityToolbox', () => {
  it('returns all tools', () => {
    const provider = createStaticIdentityProvider();
    const toolbox = createIdentityToolbox(provider);

    expect(toolbox.soulDiff).toBeDefined();
    expect(toolbox.soulAccept).toBeDefined();
    expect(toolbox.soulReject).toBeDefined();
    expect(toolbox.soulPin).toBeDefined();
    expect(toolbox.soulView).toBeDefined();
    expect(toolbox.personaList).toBeDefined();
    expect(toolbox.personaView).toBeDefined();
    expect(toolbox.personaCreate).toBeDefined();
    expect(toolbox.personaUpdate).toBeDefined();
    expect(toolbox.personaDelete).toBeDefined();
  });
});
