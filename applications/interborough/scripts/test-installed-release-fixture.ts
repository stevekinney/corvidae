import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function writeFixture(
  home: string,
  executable: string,
  marker: string,
): Promise<void> {
  const plugins = join(home, 'plugins');
  await mkdir(plugins, { recursive: true });
  const runtime = resolve(
    dirname(await realpath(executable)),
    '..',
    'share',
    'interborough',
    'plugin-runtime',
    'node_modules',
  );
  await linkPluginRuntime(home, runtime);
  const fixtureDirectory = join(plugins, 'installed-fixture');
  const fixtureDependency = join(fixtureDirectory, 'node_modules', 'fixture-dependency');
  await mkdir(fixtureDependency, { recursive: true });
  await writeFile(
    join(fixtureDependency, 'package.json'),
    '{"name":"fixture-dependency","type":"module","exports":"./index.ts"}\n',
  );
  await writeFile(
    join(fixtureDependency, 'index.ts'),
    'export const dependencyMarker = "fixture-owned-dependency";\n',
  );
  const source = `import { definePlugin } from '@lostgradient/interborough-plugin';
import { createTool } from 'armorer';
import { writeFile } from 'node:fs/promises';
import { dependencyMarker } from 'fixture-dependency';
import { z } from 'zod';
const text = { input: true, output: true, sourceForms: ['inline'] };
const none = { input: false, output: false, sourceForms: [] };
const seed = { endpoint: 'scripted', lifecycle: 'stable', modalities: { text, image: none, document: none, audio: none, video: none, file: none }, mimeFamilies: ['text'], mediaLimits: [], mediaCounts: [], providerFetchesRemoteUrls: false, contextWindowTokens: 8192, maxOutputTokens: 1024, streaming: false, tools: true, parallelTools: false, structuredOutput: false, parameterCompatibility: ['model'], caching: false, batchInference: false, explicitThinkingRequest: false, serverSideTokenCounting: false, effort: { portable: [], nativeMapping: 'unsupported', degradesTo: {} }, availability: 'available', health: 'unknown', source: 'static', freshness: '2026-11-13T00:00:00.000Z' };
const CALL_ID = 'installed-call-1';
export default definePlugin({ name: 'installed-fixture', version: '1.0.0', description: 'Installed release fixture', secrets: [{ key: 'installed-fixture-key', generated: true }], content: new URL('./content/', import.meta.url), setup: () => ({
  tools: [createTool({ name: 'greet', description: 'Fixture greeting', input: z.object({ name: z.string() }), metadata: { readOnly: true }, execute: async ({ name }) => { await writeFile(${JSON.stringify(marker)}, dependencyMarker); return 'fixture greeted ' + name; } })],
  providers: [{ name: 'installed-fixture', generate: () => async ({ conversation }) => { const result = conversation.getMessages().findLast((message) => message.toolResult?.callId === CALL_ID)?.toolResult; return result === undefined ? { content: '', toolCalls: [{ id: CALL_ID, name: 'installed-fixture__greet', arguments: { name: 'Ada' } }] } : { content: 'Fixture result: ' + String(result.content), toolCalls: [] }; }, stream: () => { throw new Error('fixture provider does not stream'); }, rows: [{ ...seed, provider: 'installed-fixture', model: 'scripted', aliases: [] }] }],
  panels: [{ name: 'fixture-panel', title: 'Fixture panel', description: 'Installed panel', uri: 'ui://installed-fixture/panel/v1', entry: new URL('./app.ts', import.meta.url), styles: '#root { color: green; }', allowedTools: ['bureau.workflows-list'], opensFromTool: 'bureau.workflows-list' }]
}) });
`;
  await writeFile(join(plugins, 'installed-fixture', 'plugin.ts'), source);
  await writeFile(
    join(plugins, 'installed-fixture', 'app.ts'),
    `import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'installed-fixture-panel', version: '1.0.0' }, {});
app.onteardown = async () => { document.body.replaceChildren(); return {}; };
await app.connect();
document.body.innerHTML = '<main>Installed fixture MCP panel</main>';
`,
  );
  await mkdir(join(home, 'plugins', 'installed-fixture', 'content', 'agents'), { recursive: true });
  await writeFile(
    join(home, 'plugins', 'installed-fixture', 'content', 'agents', 'assistant.md'),
    `---\nname: installed fixture assistant\nmodel: installed-fixture/scripted\ntools: [installed-fixture:greet]\n---\nUse the fixture greeting tool.\n`,
  );
  await mkdir(join(plugins, 'broken'), { recursive: true });
  await writeFile(
    join(plugins, 'broken', 'plugin.ts'),
    `import './missing-installed-import.ts';\nexport default {};\n`,
  );
  await mkdir(join(home, 'workflows'), { recursive: true });
  await writeFile(
    join(home, 'workflows', 'installed-cli-workflow.json'),
    JSON.stringify({
      name: 'installed-cli-workflow',
      trigger: { kind: 'manual' },
      steps: [
        {
          kind: 'activity',
          handler: 'agent',
          input: { agent: 'installed-fixture:assistant', message: 'workflow hello' },
        },
      ],
    }),
  );
}

export async function linkPluginRuntime(home: string, runtime: string): Promise<void> {
  await symlink(runtime, join(home, 'plugins', 'node_modules'), 'dir');
}
