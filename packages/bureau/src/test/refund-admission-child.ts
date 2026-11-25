import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { resolve } from 'node:path';

const [path, commandId, amount] = process.argv.slice(2);
if (!path || !commandId || !amount) throw new Error('Missing fixture arguments');
const modulePath = resolve(import.meta.dir, '../../../../plugins/demo/src/refund-ledger.ts');
const { createRefundLedger } = await import(modulePath);
const storage = new BunSQLiteStorage(path);
console.log('ready');
await Bun.stdin.stream().getReader().read();
try {
  const refund = await createRefundLedger(storage).admit({
    merchant: 'merchant',
    commandId,
    order: 'order',
    amount: Number(amount),
    toolRevision: '1.1.0',
    owner: 'alice',
  });
  console.log(JSON.stringify({ id: refund.id }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
} finally {
  storage[Symbol.dispose]();
}
