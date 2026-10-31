import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { createPlugin, pluginScaffold } from './create-plugin.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'create-plugin-'));
  roots.push(root);
  return root;
}

describe('createPlugin', () => {
  test('writes plugin.ts, an agent file, a workflow file, a skill and a test, each naming the plugin', async () => {
    const root = await scratch();
    const result = await createPlugin('example', root);
    expect(result).toEqual({ folder: join(root, 'example') });
    for (const [path, text] of Object.entries(pluginScaffold('example'))) {
      expect(await Bun.file(join(root, 'example', path)).text()).toBe(text);
    }
    expect(Object.keys(pluginScaffold('example')).toSorted()).toEqual([
      'content/agents/assistant.md',
      'content/skills/greeting/SKILL.md',
      'content/workflows/digest.json',
      'plugin.test.ts',
      'plugin.ts',
    ]);
    expect(pluginScaffold('example')['plugin.ts']).toContain("name: 'example'");
    expect(pluginScaffold('example')['content/agents/assistant.md']).toContain(
      'tools: [example:greet]',
    );
  });

  test('ships a workflow named in the plugin’s namespace and a skill named for its folder', () => {
    const files = pluginScaffold('example');
    const workflow = JSON.parse(files['content/workflows/digest.json'] ?? '') as {
      name: string;
      trigger: { kind: string };
      steps: { input: { agent: string } }[];
    };
    expect(workflow.name).toBe('example:digest');
    expect(workflow.trigger.kind).toBe('signal');
    expect(workflow.steps[0]?.input.agent).toBe('example:assistant');
    expect(files['content/skills/greeting/SKILL.md']).toContain('name: greeting\n');
    expect(files['content/skills/greeting/SKILL.md']).toContain('example:greet');
  });

  test('refuses a name outside the plugin grammar and writes nothing', async () => {
    const root = await scratch();
    for (const name of ['Example', '1st', 'two_words', 'ends-', '']) {
      const result = await createPlugin(name, root);
      expect(result).toEqual({ problem: expect.stringContaining('is not a plugin name') });
    }
    expect(await Array.fromAsync(new Bun.Glob('*').scan({ cwd: root, onlyFiles: false }))).toEqual(
      [],
    );
  });

  test('refuses a folder that already exists', async () => {
    const root = await scratch();
    await mkdir(join(root, 'example'));
    expect(await createPlugin('example', root)).toEqual({
      problem: expect.stringContaining('already exists'),
    });
  });

  test('refuses a missing name or destination', async () => {
    expect(await createPlugin(undefined, '/tmp')).toEqual({
      problem: expect.stringContaining('Usage'),
    });
    expect(await createPlugin('example', undefined)).toEqual({
      problem: expect.stringContaining('Usage'),
    });
  });
});
