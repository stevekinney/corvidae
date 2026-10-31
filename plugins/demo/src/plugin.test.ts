import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing';
import { afterEach, describe, expect, test } from 'bun:test';

import { DEMO_AGENT_NAMES } from './agents.ts';
import plugin, { createDemoPlugin, DEMO_APPROVAL_SECRET } from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

async function start(
  options: {
    readonly enabled?: boolean;
    readonly secret?: string;
    readonly seedOnStart?: boolean;
  } = {},
) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    plugins: [
      {
        descriptor: createDemoPlugin({ seedOnStart: options.seedOnStart ?? false }),
        source: 'package',
        location: '@lostgradient/plugin-demo',
      },
    ],
    ...(options.enabled === false ? {} : { pluginConfiguration: { demo: { enabled: true } } }),
    pluginSecrets: {
      get: async (key) => (key === DEMO_APPROVAL_SECRET ? options.secret : undefined),
      watch: () => () => {},
    },
    storage: new MemoryStorage(),
    durable: true,
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the demo plugin', () => {
  test('is off until the owner turns it on, and then contributes no agent', async () => {
    const bureau = await start({ enabled: false });
    const [listing] = await bureau.plugins.list();
    expect(listing).toMatchObject({ descriptor: { name: 'demo' }, status: 'disabled' });
    expect(bureau.agents.list().filter(({ id }) => id.startsWith('demo:'))).toEqual([]);
  });

  test('declares one generated secret of its own, never the host’s approval secret', () => {
    expect(plugin.secrets).toEqual([{ key: 'demo-approval-secret', generated: true }]);
    expect(plugin.enabledByDefault).toBe(false);
  });

  test('lists the six agents under its prefix once enabled', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const ids = bureau.agents
      .list()
      .map(({ id }) => id)
      .filter((id) => id.startsWith('demo:'))
      .toSorted();
    expect(ids).toEqual(DEMO_AGENT_NAMES.map((name) => `demo:${name}`).toSorted());
  });

  test('answers from its scripts', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const assistantTask = await bureau.tasks.start('demo:assistant', 'Hello');
    const assistant = await assistantTask.result();
    expect(assistant.content).toBe(
      'Hello from the assistant. This reply is scripted; no model was called.',
    );
    const echoTask = await bureau.tasks.start('demo:echo', 'Say this back');
    const echo = await echoTask.result();
    expect(echo.content).toBe('Say this back');
  });

  test('tool-runner stops on a refund that waits for an operator, signed with its own secret', async () => {
    const bureau = await start({ secret: 'fixture-demo-approval-secret' });
    const task = await bureau.tasks.start('demo:tool-runner', 'Refund order-1001');
    const result = await task.result();
    const calls = result.steps.flatMap((step) =>
      step.results.map((outcome) => [outcome.toolName, outcome.outcome] as const),
    );
    expect(calls).toEqual([
      ['lookup-order', 'success'],
      ['issue-refund', 'action_required'],
    ]);
    expect(result.steps.at(-1)?.results[0]?.pendingApproval).toBeDefined();
  });

  test('is needs-setup without its secret, and a demo agent refuses to run', async () => {
    const bureau = await start({});
    const [listing] = await bureau.plugins.list();
    expect(listing?.status).toBe('needs-setup');
    expect(listing?.problems.map(({ code }) => code)).toEqual(['secret-missing']);
    const refusal = await rejectionOf(bureau.tasks.start('demo:assistant', 'Hello'));
    expect(String(refusal)).toMatch(/needs setup/);
  });
});
