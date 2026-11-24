import { importEncryptionKey } from '@lostgradient/cryptography';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';

import { fireRunEvents, openHooksBureau, SIGNING_SECRET } from './hooks.test-support.ts';

const [path, url, encodedKey] = process.argv.slice(2);
if (path === undefined || url === undefined || encodedKey === undefined)
  throw new Error('Missing fixture arguments');
const storage = new BunSQLiteStorage(path);
const opened = await openHooksBureau({
  storage,
  fetch,
  key: await importEncryptionKey(encodedKey),
  now: () => 1_800_000_000_000,
  durable: false,
});
await opened.bureau.hooks!.create({
  url,
  events: ['run.registered'],
  signingSecret: SIGNING_SECRET,
  principal: 'api-key:alice',
});
await fireRunEvents(opened.bureau);
// The parent kills this sender only after the recipient's transaction commits.
await new Promise<void>(() => {});
