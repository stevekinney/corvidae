import { mock } from 'bun:test';

const mode = process.argv[2];
const metadata: { orphanedRuns?: string[] } = {};
let classifyCalls = 0;
let enteredFirst!: () => void;
const firstEntered = new Promise<void>((resolve) => {
  enteredFirst = resolve;
});
let releaseFirst!: () => void;
const firstHeld = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const credential = 'postgres://user:hunter2@host/db';
const logged: string[] = [];
const recovery = await import('./server-owned-recovery.ts');

await mock.module('./server-owned-conversations.ts', () => ({
  AGENT_NAME: 'test-agent',
  loadConversation: async () => ({ metadata }),
  orphanedRunsOf: (value: typeof metadata) => value.orphanedRuns ?? [],
  rememberOrphanedRuns: async (_id: string, runIds: readonly string[]) => {
    if (mode === 'persistence-failure') throw new Error('sqlite password leaked');
    metadata.orphanedRuns = [...(metadata.orphanedRuns ?? []), ...runIds];
  },
}));
await mock.module('./server-owned-runtime.ts', () => ({
  serverOwnedRuntime: () => ({ sessions: {}, durability: 'memory' }),
}));
await mock.module('./server-owned-durable.ts', () => ({
  durableRuntime: async () => ({ engine: {}, checkpointStore: {} }),
}));
await mock.module('./toolbox.ts', () => ({ emptyToolbox: {} }));
await mock.module('@repo/operative', () => ({ createSessionHandle: () => ({}) }));
await mock.module('./server-owned-unavailable.ts', () => ({
  raise: (cause: unknown) => {
    throw cause;
  },
  unavailableDuringShutdown: () => undefined,
}));
await mock.module('./server-owned-recovery.ts', () => ({
  ...recovery,
  classifyRecovery: async () => {
    classifyCalls += 1;
    if (mode === 'concurrent' && classifyCalls === 1) {
      enteredFirst();
      await firstHeld;
      return { kind: 'orphaned', failures: [{ runId: 'run-1', reason: 'lost' }] };
    }
    if (mode === 'redaction' || mode === 'persistence-failure') {
      return {
        kind: 'orphaned',
        failures: [
          {
            runId: mode === 'redaction' ? 'run-secret' : 'run-orphaned',
            reason: `${credential} unreachable`,
          },
        ],
      };
    }
    return { kind: 'nothing-to-resume' };
  },
}));

globalThis.console.error = (...values: unknown[]) => {
  logged.push(values.map(String).join(' '));
};
process.stderr.write = (chunk: string | Uint8Array) => {
  logged.push(String(chunk).trimEnd());
  return true;
};

const { recoverConversationResponse } = await import('./server-owned-recovery-response.ts');
if (mode === 'concurrent') {
  const first = recoverConversationResponse('conversation-1');
  await firstEntered;
  const second = recoverConversationResponse('conversation-1');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const classifyCallsBeforeRelease = classifyCalls;
  releaseFirst();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  const firstBody = await firstResponse.json();
  process.stdout.write(
    JSON.stringify({
      classifyCallsBeforeRelease,
      firstKind: firstBody.kind,
      second: await secondResponse.json(),
    }),
  );
} else if (mode === 'redaction' || mode === 'persistence-failure') {
  const response = await recoverConversationResponse('conversation-secret');
  process.stdout.write(JSON.stringify({ response: await response.json(), logged }));
} else {
  throw new Error(`unknown fixture mode: ${String(mode)}`);
}
