import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { resolve } from 'node:path';

const [ledgerPath, processorPath, id, point] = process.argv.slice(2);
if (!ledgerPath || !processorPath || !id || !point) throw new Error('Missing fixture arguments');
const ledgerModule = resolve(import.meta.dir, '../../../../plugins/demo/src/refund-ledger.ts');
const processorModule = resolve(
  import.meta.dir,
  '../../../../plugins/demo/src/refund-processor.ts',
);
const { createRefundLedger } = await import(ledgerModule);
const { createFakeProcessor } = await import(processorModule);
const ledger = createRefundLedger(new BunSQLiteStorage(ledgerPath));
const barrier = async () => {
  console.log('barrier');
  await new Response(Bun.stdin.stream()).text();
};
const processor = createFakeProcessor(
  new BunSQLiteStorage(processorPath),
  point === 'after-acceptance' ? barrier : undefined,
);
const attempt = await ledger.claim(id, 100);
if (point === 'before-send') {
  await barrier();
}
const result = await processor.submit(attempt);
await barrier();
await ledger.apply(id, attempt.fence, result.status, result.receipt);
