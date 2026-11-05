import { resolveProviderGenerate } from '@lostgradient/bureau';
import { createEgressPolicy } from '@lostgradient/weft/a2a';

import { startHost, type HostOptions } from './host.ts';

const environment = process.env;
const required = [
  'READY_FILE',
  'BOOT_FILE',
  'RUN_FILE',
  'JOURNAL_FILE',
  'REVIEW_FILE',
  'APPROVE_FILE',
  'GO_FILE',
  'KEY_FILE',
  'RESULT_FILE',
  'ERROR_FILE',
  'SEND_FILE',
  'ATTACH_FILE',
  'AUTH_ATTACH_FILE',
  'AUDIT_FILE',
  'SESSION_ID_FILE',
  'SESSION_FILE',
  'PEER_PORT',
];
const value = (key: string): string => {
  const result = environment[key];
  if (result === undefined) throw new Error(`caller fixture environment is missing ${key}`);
  return result;
};
function isPeerCallKey(candidate: unknown): candidate is {
  parentRunId: string;
  operationKey: string;
} {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return (
    'parentRunId' in candidate &&
    typeof candidate.parentRunId === 'string' &&
    'operationKey' in candidate &&
    typeof candidate.operationKey === 'string'
  );
}
const home = value('INTERBOROUGH_HOME');
for (const key of required) value(key);
await Bun.write(value('BOOT_FILE'), 'booting');
if (!(await Bun.file(value('SEND_FILE')).exists())) await Bun.write(value('SEND_FILE'), '0');

let recoveryTaskId: string | undefined;
if (environment['RESTART'] === '1') {
  const journal = JSON.parse(await Bun.file(value('JOURNAL_FILE')).text()) as unknown;
  if (typeof journal === 'object' && journal !== null && 'entry' in journal) {
    const entry = journal.entry;
    if (typeof entry === 'object' && entry !== null && 'taskId' in entry) {
      const taskId = entry.taskId;
      if (typeof taskId === 'string') recoveryTaskId = taskId;
    }
  }
  if (recoveryTaskId === undefined) throw new Error('recovery journal has no task ID');
}

const fetchWithoutCredentials = globalThis.fetch;
const peerFetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let body = typeof init?.body === 'string' ? init.body : undefined;
    let requestMethod: string | undefined;
    try {
      const request = new Request(input, init);
      requestMethod = request.method;
      if (body === undefined) {
        requestMethod = request.method;
        body = await request.clone().text();
      }
    } catch {
      body = undefined;
    }
    let method: unknown;
    let requestTaskId: string | undefined;
    try {
      const parsed: unknown = body === undefined ? undefined : JSON.parse(body);
      method =
        typeof parsed === 'object' && parsed !== null && 'method' in parsed
          ? parsed.method
          : undefined;
      const params =
        typeof parsed === 'object' && parsed !== null && 'params' in parsed
          ? parsed.params
          : undefined;
      const id =
        typeof params === 'object' && params !== null && 'id' in params ? params.id : undefined;
      requestTaskId =
        typeof id === 'string'
          ? id
          : typeof id === 'object' && id !== null && 'id' in id && typeof id.id === 'string'
            ? id.id
            : undefined;
    } catch {
      method = undefined;
    }
    if (method === 'SendMessage' || method === 'SendStreamingMessage') {
      const countFile = Bun.file(value('SEND_FILE'));
      const previous = (await countFile.exists()) ? Number(await countFile.text()) : 0;
      await Bun.write(value('SEND_FILE'), String(previous + 1));
    }
    const response = await fetchWithoutCredentials(input, init);
    if (
      recoveryTaskId !== undefined &&
      (method === 'GetTask' || method === 'SubscribeToTask' || requestMethod === 'POST')
    ) {
      await Bun.write(
        value('AUTH_ATTACH_FILE'),
        JSON.stringify({
          method: method ?? requestMethod,
          taskId: requestTaskId,
          status: response.status,
        }),
      );
    }
    return response;
  },
  { preconnect: globalThis.fetch.preconnect },
);

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
  a2aPeerFetch: peerFetch,
  a2aPeerRecoveryUpdate: (update) => {
    if (
      recoveryTaskId !== undefined &&
      update.taskId === recoveryTaskId &&
      update.state !== 'completed' &&
      update.state !== 'failed' &&
      update.state !== 'canceled' &&
      update.state !== 'rejected'
    ) {
      void Bun.write(value('ATTACH_FILE'), JSON.stringify(update));
    }
  },
});
const peerCalls = host.bureau.peerCalls;
const originalWrite = peerCalls.write.bind(peerCalls);
peerCalls.write = async (key, entry) => {
  await originalWrite(key, entry);
  await Bun.write(value('KEY_FILE'), JSON.stringify(key));
};
await Bun.write(value('READY_FILE'), 'ready');
await Bun.write(environment['URL_FILE'] ?? `${home}/caller-url`, host.url.href);

if (environment['RESTART'] === '1') {
  const runText = await Bun.file(value('RUN_FILE')).text();
  const runId = runText.trim();
  const sessionIdFile = Bun.file(value('SESSION_ID_FILE'));
  const sessionIdText = await sessionIdFile.text();
  const sessionId = sessionIdText.trim();
  const sessionStore = host.bureau.internals.sessionStore;
  if (sessionStore === undefined)
    throw new Error('recovery fixture requires a durable session store');
  const session = await sessionStore.load(sessionId);
  await Bun.write(value('SESSION_FILE'), JSON.stringify(session ?? null));
  const result = await host.bureau.tasks.wait(runId);
  await Bun.write(value('RESULT_FILE'), JSON.stringify(result));
  const audit = await host.bureau.internals.auditTrail?.query({ runId });
  await Bun.write(value('AUDIT_FILE'), JSON.stringify(audit ?? []));
} else {
  try {
    const run = await host.bureau.tasks.start('caller', 'Delegate the work.', {
      principal: 'anonymous:local',
    });
    await Bun.write(value('RUN_FILE'), run.id);
    for (;;) {
      const review = host.bureau.reviews.list().find((candidate) => candidate.runId === run.id);
      if (review?.kind === 'tool-approval') {
        await Bun.write(value('REVIEW_FILE'), review.id);
        await Bun.write(value('SESSION_ID_FILE'), review.sessionId);
        break;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    while (!(await Bun.file(value('APPROVE_FILE')).exists()))
      await new Promise<void>((resolve) => setImmediate(resolve));
    const reviewFile = await Bun.file(value('REVIEW_FILE')).text();
    const reviewId = reviewFile.trim();
    void host.bureau.reviews
      .resolve({ id: reviewId, decision: 'approve', principal: 'anonymous:local' })
      .catch(() => undefined);
    while (!(await Bun.file(value('GO_FILE')).exists()))
      await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      if (await Bun.file(value('KEY_FILE')).exists()) {
        const key = JSON.parse(await Bun.file(value('KEY_FILE')).text()) as unknown;
        if (!isPeerCallKey(key)) throw new Error('caller fixture journal key is malformed');
        const entry = await peerCalls.read(key);
        if (entry !== undefined) {
          await Bun.write(value('JOURNAL_FILE'), JSON.stringify({ key, entry }));
          break;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>(() => {});
  } catch (error) {
    await Bun.write(value('ERROR_FILE'), String(error));
    await new Promise<void>(() => {});
  }
}
