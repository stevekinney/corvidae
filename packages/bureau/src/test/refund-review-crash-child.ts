import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { resolve } from 'node:path';
import { createBureau } from '../create-bureau';

const path = process.argv[2];
if (!path) throw new Error('Missing storage path');
const modulePath = resolve(import.meta.dir, '../../../../plugins/demo/src/plugin.ts');
const { createDemoPlugin, DEMO_APPROVAL_SECRET } = await import(modulePath);
const storage = new BunSQLiteStorage(path);
const conditional = storage.conditionalBatch.bind(storage);
storage.conditionalBatch = async (conditions, operations, deadline) => {
  const release = operations.find(
    (operation) =>
      operation.type === 'put' &&
      operation.key.includes(':reservation:') &&
      new TextDecoder().decode(operation.value).includes('"released"'),
  );
  if (release) {
    console.log('release-barrier');
    await new Response(Bun.stdin.stream()).text();
  }
  return conditional(conditions, operations, deadline);
};
const bureau = await createBureau({
  agents: {},
  plugins: [
    {
      descriptor: createDemoPlugin({ seedOnStart: false }),
      source: 'package',
      location: '@lostgradient/plugin-demo',
    },
  ],
  pluginConfiguration: { demo: { enabled: true } },
  pluginSecrets: {
    get: async (key) => (key === DEMO_APPROVAL_SECRET ? 'fixture-secret' : undefined),
    watch: () => () => {},
  },
  storage,
  durable: true,
  runtime: createManualRuntimeServices({ origin: '2026-01-01T00:00:00.000Z' }),
});
const task = await bureau.tasks.start('demo:tool-runner', 'Refund');
await task.result();
const [review] = bureau.reviews.list();
if (!review || review.kind !== 'tool-approval') throw new Error('Missing review');
await bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'operator' });
