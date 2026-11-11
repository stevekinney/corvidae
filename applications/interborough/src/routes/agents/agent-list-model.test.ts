import { describe, expect, test } from 'bun:test';

import {
  activityText,
  agentRowTitle,
  availableRow,
  holdingPlugins,
  rowMatches,
  rowStatus,
  sortByActivity,
  unavailableRow,
  type AgentRow,
} from './agent-list-model.ts';

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

// Tuesday, Nov 3 2026, 12:00 PM UTC: every time below is read in UTC so the zone cannot move a day.
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const ZONE = 'UTC';

const summary = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  displayName: name,
  description: `The ${name} agent.`,
  kind: 'code' as 'code' | 'file',
  media: null as typeof MEDIA | null,
  ...extra,
});

const used = (lastChatAt: number | null, count = 1, waiting = 0) => ({
  count,
  lastChatAt,
  waiting,
  running: 0,
});

describe('what an agent is called in a row', () => {
  test('reads an identifier in words, and drops the namespace of a plugin', () => {
    expect(agentRowTitle('tool-runner')).toBe('Tool runner');
    expect(agentRowTitle('demo:tool-runner')).toBe('Tool runner');
    expect(agentRowTitle('Request human input')).toBe('Request human input');
  });
});

describe('an agent that can run', () => {
  test('is built in when the host defines it in code with no plugin namespace', () => {
    expect(availableRow(summary('assistant'), undefined).builtIn).toBe(true);
    expect(availableRow(summary('demo:assistant'), undefined).builtIn).toBe(false);
    expect(availableRow(summary('researcher', { kind: 'file' }), undefined).builtIn).toBe(false);
  });

  test('has an editor only when it is a file, and needs a provider only when it names a model', () => {
    const file = availableRow(summary('researcher', { kind: 'file', media: MEDIA }), undefined);
    expect(file.editable).toBe(true);
    expect(file.usesModel).toBe(true);
    const code = availableRow(summary('assistant'), undefined);
    expect(code.editable).toBe(false);
    expect(code.usesModel).toBe(false);
  });

  test('carries the plugin that ships it, and the chats had with it', () => {
    const chats = used(NOW);
    const row = availableRow(summary('demo:tool-runner'), chats);
    expect(row.plugin).toBe('demo');
    expect(row.usage).toBe(chats);
    expect(row.state).toBe('available');
  });
});

describe('an agent a disabled plugin holds back', () => {
  test('keeps the identifier, says why in the host’s words, and offers neither an editor nor a model', () => {
    const row = unavailableRow(
      {
        id: 'demo:release-helper',
        name: 'release-helper',
        description: 'Drafts release notes.',
        unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
      },
      undefined,
    );
    expect(row).toMatchObject({
      id: 'demo:release-helper',
      title: 'Release helper',
      state: 'unavailable',
      plugin: 'demo',
      reason: 'Plugin Demo is disabled',
      editable: false,
      usesModel: false,
      builtIn: false,
    });
  });

  test('has no reason when the host gave none', () => {
    const row = unavailableRow(
      { id: 'demo:echo', name: 'echo', description: null, unavailable: null },
      undefined,
    );
    expect(row.reason).toBeNull();
  });
});

describe('when an agent was last used', () => {
  test('says the clock for today, Yesterday for the day before, and the day for anything older', () => {
    expect(activityText(Date.parse('2026-11-03T10:42:00.000Z'), NOW, ZONE)).toBe('10:42 AM');
    expect(activityText(Date.parse('2026-11-02T16:12:00.000Z'), NOW, ZONE)).toBe('Yesterday');
    expect(activityText(Date.parse('2026-10-21T09:46:00.000Z'), NOW, ZONE)).toBe('Oct 21');
  });

  test('says an agent no chat has touched has no activity yet', () => {
    expect(activityText(null, NOW, ZONE)).toBe('No activity yet');
  });

  test('reads a time in the future as today’s', () => {
    expect(activityText(NOW + 60_000, NOW, ZONE)).toBe('12:01 PM');
  });
});

describe('the order of the agents that can run', () => {
  const row = (id: string, lastChatAt: number | null): AgentRow =>
    availableRow(summary(id), lastChatAt === null ? undefined : used(lastChatAt));

  test('puts the most recently used first and keeps the listed order among those never used', () => {
    const rows = [
      row('model-switcher', null),
      row('assistant', NOW - 86_400_000),
      row('echo', null),
      row('tool-runner', NOW - 60_000),
      row('request-human-input', NOW - 3_600_000),
    ];
    expect(sortByActivity(rows).map((entry) => entry.id)).toEqual([
      'tool-runner',
      'request-human-input',
      'assistant',
      'model-switcher',
      'echo',
    ]);
  });

  test('leaves the rows it was given as they were', () => {
    const rows = [row('a', null), row('b', NOW)];
    sortByActivity(rows);
    expect(rows.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('the search over the rows', () => {
  const row = availableRow(
    summary('demo:tool-runner', { description: 'Looks an order up.' }),
    undefined,
  );

  test('matches the name, the identifier and the description, and everything for an empty search', () => {
    expect(rowMatches(row, '')).toBe(true);
    expect(rowMatches(row, 'tool run')).toBe(true);
    expect(rowMatches(row, 'demo:')).toBe(true);
    expect(rowMatches(row, 'order')).toBe(true);
    expect(rowMatches(row, 'echo')).toBe(false);
  });
});

describe('the plugins that hold agents back', () => {
  const held = (id: string) =>
    unavailableRow({ id, name: id, description: null, unavailable: null }, undefined);

  test('names each once, in the order the agents first name them, and leaves out agents of no plugin', () => {
    const rows = [
      held('demo:release-helper'),
      held('linear:triager'),
      held('demo:changelog-writer'),
      held('orphan'),
      availableRow(summary('demo:assistant'), undefined),
    ];
    expect(holdingPlugins(rows)).toEqual(['demo', 'linear']);
  });
});

describe('the status column', () => {
  test('says nothing for an agent that can run, Waiting on you for one with a chat that waits, and Unavailable for a held-back one', () => {
    expect(rowStatus(availableRow(summary('assistant'), undefined))).toBeUndefined();
    expect(rowStatus(availableRow(summary('assistant'), used(NOW, 2, 0)))).toBeUndefined();
    expect(rowStatus(availableRow(summary('assistant'), used(NOW, 2, 1)))).toBe('waiting');
    expect(
      rowStatus(
        unavailableRow(
          { id: 'demo:echo', name: 'echo', description: null, unavailable: null },
          undefined,
        ),
      ),
    ).toBe('unavailable');
  });
});
