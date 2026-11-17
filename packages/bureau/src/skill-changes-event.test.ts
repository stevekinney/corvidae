/**
 * COR-2100 (E4c) — the seam through which a host that discovers skills reports their changes:
 * `BureauOptions.skillChanges` is forwarded as `definitions.changed` with `catalog: 'skills'`, on
 * the feed, with no `source`, and the forwarding stops when the Bureau is disposed.
 */
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog.ts';
import { BUREAU_EVENT_CATALOG } from './bureau-event-catalog.ts';
import type { Bureau } from './bureau-types/facade.ts';
import { createBureau } from './create-bureau.ts';
import { DefinitionsChangedEvent } from './events.ts';

type Change = {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly rejected: readonly string[];
};

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A Bureau over a host's skill-change seam that the test fires by hand. */
async function open() {
  const listeners = new Set<(change: Change) => void>();
  const bureau = await createBureau<AgentDefinitions>({
    id: 'skill-changes-bureau',
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'done', toolCalls: [] }),
        toolbox: createToolbox([]),
      }),
    },
    storage: new MemoryStorage(),
    onDiagnostic: () => undefined,
    skillChanges: {
      onChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  bureaus.push(bureau);
  return {
    bureau,
    listeners,
    fire: (change: Change) => {
      for (const listener of listeners) listener(change);
    },
  };
}

async function skillEvents(bureau: Bureau) {
  const found = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    if (envelope.kind === 'definitions.changed') found.push(envelope);
  }
  return found;
}

describe('the skill changes a host reports (COR-2100)', () => {
  it('[matrix 86, 121] publishes definitions.changed with catalog skills and the four lists, and no source', async () => {
    const { bureau, fire } = await open();
    fire({ added: ['alpha'], changed: ['beta'], removed: ['gamma'], rejected: ['alpha'] });
    const [event, ...rest] = await skillEvents(bureau);
    expect(rest).toEqual([]);
    expect(event?.payload).toEqual({
      catalog: 'skills',
      added: ['alpha'],
      changed: ['beta'],
      removed: ['gamma'],
      rejected: ['alpha'],
    });
    expect(event?.source).toBeUndefined();
  });

  it('[matrix 86] the event class carries the skills catalog kind', () => {
    const event = new DefinitionsChangedEvent('skills', {
      added: [],
      changed: [],
      removed: [],
      rejected: [],
    });
    expect(event.catalog).toBe('skills');
  });

  it('stops forwarding when the Bureau is disposed', async () => {
    const { bureau, listeners } = await open();
    expect(listeners.size).toBe(1);
    await bureau.dispose();
    bureaus.splice(bureaus.indexOf(bureau), 1);
    expect(listeners.size).toBe(0);
  });

  it('[matrix 130] the catalog describes the event as a rescan of skill files too', () => {
    expect(BUREAU_EVENT_CATALOG['definitions.changed'].description).toContain('skill');
  });
});
