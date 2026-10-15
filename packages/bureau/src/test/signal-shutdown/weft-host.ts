/**
 * COR-1439 — a long-lived process hosting a Weft engine.
 *
 * `start` begins a workflow that commits its first step and then waits inside
 * its second activity, announces `ready`, and on SIGINT or SIGTERM awaits
 * `engine.shutdown()` through the reference handler. `recover` is the relaunch:
 * it opens the same store, lets recovery resume the workflow, and records its
 * terminal result.
 */
import { Engine, workflow } from '@lostgradient/weft';

import { announce, fail, openFileStorage, parseHostArguments, writeMarker } from './host-support';
import { handleShutdownSignals } from './shutdown-handler';

const WORKFLOW_ID = 'signal-shutdown-weft';

const { mode, directory } = parseHostArguments(['start', 'recover']);
const storage = await openFileStorage(directory);
const finishGate = Promise.withResolvers<void>();
let prepareCalls = 0;

const hosted = workflow({ name: 'signalShutdown' })
  .activities({
    prepare: async (value: number) => {
      prepareCalls += 1;
      return value + 1;
    },
    finish: async (value: number) => {
      // Reached only after `prepare`'s result is durable. In `start` the
      // activity waits for good; the relaunched process completes it.
      if (mode === 'start') {
        finishGate.resolve();
        await new Promise<never>(() => {});
      }
      return value * 2;
    },
  })
  .execute(async function* (context, input: { value: number }) {
    const prepared = yield* context.run('prepare', input.value);
    const finished = yield* context.run('finish', prepared);
    return { prepared, finished };
  });

const engine = await Engine.create({
  storage,
  workflows: { signalShutdown: hosted },
  ownership: 'workflow-lease',
  workflowClaimTtl: 200,
  workflowClaimRenewInterval: 50,
});

if (mode === 'start') {
  handleShutdownSignals({
    shutdown: async () => {
      const released = await engine.shutdown();
      writeMarker(directory, 'weft-shutdown', { released });
      storage[Symbol.dispose]();
      return released;
    },
  });
  await engine.start('signalShutdown', { value: 20 }, { id: WORKFLOW_ID });
  await finishGate.promise;
  announce('ready', { storage: storage.constructor.name });
} else {
  const result = await engine.getHandle(WORKFLOW_ID).result();
  const state = await engine.get(WORKFLOW_ID);
  if (state === null) fail('the recovered workflow has no state');
  writeMarker(directory, 'weft-recovered', { result, status: state.status, prepareCalls });
  await engine.shutdown();
  storage[Symbol.dispose]();
  process.exit(0);
}
