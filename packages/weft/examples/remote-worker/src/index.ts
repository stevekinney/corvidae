/**
 * COR-151 "Public Surface and Documentation" — a remote-mode example: an
 * engine configured with `activityExecution: { mode: 'remote' }`, dispatching
 * a `ctx.run()` activity through a real `serve()` server to a real
 * `RemoteWorker`, never falling back to a local implementation.
 *
 * Every symbol here comes from `@lostgradient/weft`'s public `exports` map
 * (`package.json`'s `"." : "./src/index.ts"`) — no deep relative import into
 * `src/` — the same boundary `examples/checkout` and `examples/order-processing`
 * already hold themselves to. This also doubles as this project's
 * packed-consumer end-to-end fixture (see the COR-151 decision record):
 * Corvidae is a private, unpublished workspace with no `prepack`/tarball step
 * to verify against (AGENTS.md forbids adding one),
 * so a real engine + real server + real `RemoteWorker` reached only through
 * this public surface is the closest available substitute for "install the
 * package and use it."
 */
import { Engine, RemoteWorker, activity, serve, workflow } from '@lostgradient/weft';

export interface RemoteWorkerExampleResult {
  greeting: string;
  workerId: string;
}

// Never runs — proves the engine took the "dispatch remotely" branch rather
// than a local fallback (`activityExecution: { mode: 'remote' }` has no local
// fallback branch at all; this is defense in depth for the example reader).
export const formatGreetingRemotely = activity({
  name: 'formatGreetingRemotely',
  execute: async (_input: { name: string }): Promise<string> => {
    throw new Error(
      'formatGreetingRemotely must never run locally — activityExecution.mode is "remote"',
    );
  },
});

export const remoteGreetingWorkflow = workflow({ name: 'remoteGreeting' })
  .activities({ formatGreetingRemotely })
  .execute(async function* (context, input: { name: string }) {
    return yield* context.run(formatGreetingRemotely, input);
  });

/**
 * `RemoteWorker`'s activity table is untyped at the input boundary
 * (`(input: unknown) => Promise<unknown>`) — the wire carries JSON, not a
 * statically known shape — so the worker-side implementation validates its
 * own input with a real type guard rather than casting it.
 */
function isGreetingInput(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/**
 * Run the remote-greeting workflow end to end: a real engine (remote-mode
 * activity execution), a real `serve()` server, and a real `RemoteWorker`
 * that supplies the actual implementation. Everything is disposed before
 * returning, whether the run succeeds or throws.
 */
export async function runRemoteWorkerExample(name = 'Ada'): Promise<RemoteWorkerExampleResult> {
  const engine = new Engine({ activityExecution: { mode: 'remote' } }).register(
    remoteGreetingWorkflow,
  );
  const server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });
  const workerId = `remote-worker-example-${Date.now()}`;
  const remoteWorker = new RemoteWorker({
    serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
    workerId,
    deploymentName: 'remote-worker-example',
    buildId: 'example-build',
    workflows: {
      remoteGreeting: {
        name: 'remoteGreeting',
        activities: {
          async formatGreetingRemotely(input: unknown) {
            if (!isGreetingInput(input)) {
              throw new Error('expected { name: string }');
            }
            return `Hello, ${input.name}! (via ${workerId})`;
          },
        },
      },
    },
    concurrency: 1,
  });

  try {
    await remoteWorker.connect();
    const handle = await engine.start('remoteGreeting', { name }, { id: `remote-worker-${name}` });
    const greeting = await handle.result();
    if (typeof greeting !== 'string') {
      throw new Error(`expected the remote worker to return a string, got ${typeof greeting}`);
    }
    return { greeting, workerId };
  } finally {
    await remoteWorker.disconnect();
    await server.stop();
    engine[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const result = await runRemoteWorkerExample();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
