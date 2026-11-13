/**
 * COR-2233 — a plugin's code agent may carry a `title`, a `visibility` and a `version`. The version
 * is the one a run pins in place of the plugin's (COR-2230); a `hidden` agent is flagged on
 * `bureau.agents.list` for Chat to leave out, yet workflows, children and direct starts still run
 * it by name.
 */
import type { PluginAgentVisibility } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { type ComposableOptions, composePlugins } from './plugins/compose-plugins';
import { runTask } from './test';
import { versionedPlugin } from './testing/versioned-plugin-agent.test-support';

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const answer = async () => ({ content: 'echoed', toolCalls: [] });

describe('what composition records of a plugin agent', () => {
  const cases: readonly {
    readonly name: string;
    readonly agentVersion?: string;
    readonly title?: string;
    readonly visibility?: PluginAgentVisibility;
    readonly expected: { version: string; title?: string; visibility?: string };
  }[] = [
    { name: 'no metadata: the plugin’s version', expected: { version: '1.0.0' } },
    {
      name: 'its own version replaces the plugin’s',
      agentVersion: '2.5.0',
      expected: { version: '2.5.0' },
    },
    { name: 'a title', title: 'Echo', expected: { version: '1.0.0', title: 'Echo' } },
    {
      name: 'a hidden agent',
      visibility: 'hidden',
      expected: { version: '1.0.0', visibility: 'hidden' },
    },
    {
      name: 'a chat agent',
      visibility: 'chat',
      expected: { version: '1.0.0', visibility: 'chat' },
    },
  ];
  for (const row of cases) {
    it(row.name, async () => {
      const { agentDetails } = await composePlugins({
        plugins: [
          versionedPlugin({
            version: '1.0.0',
            generate: answer,
            ...(row.agentVersion === undefined ? {} : { agentVersion: row.agentVersion }),
            ...(row.title === undefined ? {} : { title: row.title }),
            ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
          }),
        ],
      });
      expect(agentDetails['p:echo']).toMatchObject({ plugin: 'p', ...row.expected });
    });
  }
});

describe('a plugin that declares a secret', () => {
  it('keeps its agent’s version, title and visibility through the secret gate that wraps the agent', async () => {
    const given: ComposableOptions = {
      plugins: [
        versionedPlugin({
          version: '1.0.0',
          agentVersion: '2.5.0',
          title: 'Echo',
          visibility: 'hidden',
          secret: true,
          generate: answer,
        }),
      ],
      pluginSecrets: { get: async () => 'value', watch: () => () => {} },
    };
    const { agentDetails, options } = await composePlugins(given);

    expect(Object.keys(options.agents ?? {})).toEqual(['p:echo']);
    expect(agentDetails['p:echo']).toMatchObject({
      version: '2.5.0',
      title: 'Echo',
      visibility: 'hidden',
    });
  });
});

async function bureauWith(options: Parameters<typeof versionedPlugin>[0]) {
  const bureau = await createBureau<AgentDefinitions>({
    plugins: [versionedPlugin(options)],
    storage: new MemoryStorage(),
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the agent list', () => {
  const cases: readonly {
    readonly name: string;
    readonly visibility?: PluginAgentVisibility | 'secret';
    readonly title?: string;
    readonly expected: { title?: string; visibility?: string };
  }[] = [
    { name: 'an agent with no metadata lists as it did', expected: {} },
    { name: 'a title is on the listing', title: 'Echo', expected: { title: 'Echo' } },
    { name: 'a hidden agent is flagged', visibility: 'hidden', expected: { visibility: 'hidden' } },
    { name: 'a chat agent lists as every agent does', visibility: 'chat', expected: {} },
    // A plugin that is not typed cannot hide an agent by a value the type does not name.
    { name: 'an unknown visibility is ignored', visibility: 'secret', expected: {} },
  ];
  for (const row of cases) {
    it(row.name, async () => {
      const bureau = await bureauWith({
        version: '1.0.0',
        generate: answer,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.visibility === undefined
          ? {}
          : { visibility: row.visibility as PluginAgentVisibility }),
      });
      const listing = bureau.agents.list().find(({ id }) => id === 'p:echo');
      expect(listing).toMatchObject({ state: 'ready', ...row.expected });
      if (row.title === undefined) expect(listing).not.toHaveProperty('title');
      if (row.expected.visibility === undefined) expect(listing).not.toHaveProperty('visibility');
    });
  }
});

describe('a hidden agent', () => {
  it('is still in the catalog and runs by name, as a workflow step or a child resolves it', async () => {
    const bureau = await bureauWith({ version: '1.0.0', visibility: 'hidden', generate: answer });

    expect(bureau.agents.has('p:echo')).toBe(true);
    expect(bureau.agents.find('p:echo')).toBeDefined();
    const task = await runTask(bureau, 'p:echo', 'Hello');
    expect(task.content).toBe('echoed');
  });
});
