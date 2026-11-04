import { resolveProviderGenerate } from '@lostgradient/bureau';
import { createEgressPolicy } from '@lostgradient/weft/a2a';

import { startHost, type HostOptions } from './host.ts';

const environment = process.env;
const required = [
  'READY_FILE',
  'RUN_FILE',
  'JOURNAL_FILE',
  'RESULT_FILE',
  'ERROR_FILE',
  'PEER_PORT',
];
const value = (key: string): string => {
  const result = environment[key];
  if (result === undefined) throw new Error(`caller fixture environment is missing ${key}`);
  return result;
};
const home = value('INTERBOROUGH_HOME');
for (const key of required) value(key);

const calls = { count: 0 };
const client = {
  messages: {
    create: async (request: unknown) => {
      calls.count += 1;
      const afterTool = JSON.stringify(request).includes('tool_result');
      return {
        id: `caller-${String(calls.count)}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: afterTool
          ? [{ type: 'text', text: 'caller received peer result' }]
          : [
              {
                type: 'tool_use',
                id: 'peer-call-1',
                name: 'a2a-peer:peer',
                input: { message: 'start work' },
              },
            ],
        stop_reason: afterTool ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  },
};
const resolveProvider: NonNullable<HostOptions['resolveProviderGenerate']> = (
  definitions,
  provider,
  streamEventTarget,
  streaming,
) =>
  resolveProviderGenerate(
    definitions,
    Object.assign({}, provider, { client }),
    streamEventTarget,
    streaming,
  );

const host = await startHost({
  environment: { INTERBOROUGH_HOME: home },
  port: 0,
  resolveProviderGenerate: resolveProvider,
  a2aPeerEgressPolicy: createEgressPolicy({
    allowlist: [`127.0.0.1:${value('PEER_PORT')}`],
    allowInsecureHttp: true,
  }),
});
await Bun.write(value('READY_FILE'), 'ready');
await Bun.write(environment['URL_FILE'] ?? `${home}/caller-url`, host.url.href);

if (environment['RESTART'] === '1') {
  const runText = await Bun.file(value('RUN_FILE')).text();
  const runId = runText.trim();
  const result = await host.bureau.tasks.wait(runId);
  await Bun.write(value('RESULT_FILE'), JSON.stringify(result));
} else {
  try {
    const run = await host.bureau.tasks.start('caller', 'Delegate the work.', {
      principal: 'anonymous:local',
    });
    await Bun.write(value('RUN_FILE'), run.id);
    for (;;) {
      const entry = await host.bureau.peerCalls.read({
        parentRunId: run.id,
        operationKey: 'peer-call-1',
      });
      if (entry !== undefined) {
        await Bun.write(value('JOURNAL_FILE'), JSON.stringify(entry));
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>(() => {});
  } catch (error) {
    await Bun.write(value('ERROR_FILE'), String(error));
    await new Promise<void>(() => {});
  }
}
