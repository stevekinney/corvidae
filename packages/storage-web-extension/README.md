# @lostgradient/storage-web-extension

The web-extension storage adapter. `WebExtensionStorage` is a `Storage` over `browser.storage` or `chrome.storage`, for background scripts, content scripts, and popups of a browser extension. Its only dependency is `@lostgradient/storage`, and it needs no permission beyond the `storage` permission in the extension manifest.

| Entry | What it holds |
| --- | --- |
| `@lostgradient/storage-web-extension` | `WebExtensionStorage`, `WebExtensionStorageArea`, `WebExtensionStorageOptions`. |

## Open a storage area

Pass the storage area to use: `'local'` (the default), `'sync'`, `'session'`, or `'managed'`. The adapter resolves `browser` first and falls back to `chrome`, and it drives both promise-style and callback-style APIs.

```ts
import { WebExtensionStorage } from '@lostgradient/storage-web-extension';

await using storage = new WebExtensionStorage({ area: 'local' });
const encoder = new TextEncoder();

await storage.batch([
  { type: 'put', key: 'app:orders:1', value: encoder.encode('open') },
  { type: 'put', key: 'app:orders:2', value: encoder.encode('shipped') },
]);

const keys: string[] = [];
for await (const key of storage.keys('app:orders:')) keys.push(key);
console.log(keys); // ['app:orders:1', 'app:orders:2']
```

Under a test, or in a context where the extension API is not on `globalThis`, pass the namespace as the second argument.

```ts
import { WebExtensionStorage } from '@lostgradient/storage-web-extension';

declare const extensionNamespace: unknown;

await using storage = new WebExtensionStorage({ area: 'session' }, extensionNamespace);
await storage.put('app:greeting', new TextEncoder().encode('hello'));
```

## What it guarantees

- Values are stored as JSON envelopes holding base64-encoded bytes, under one reserved keyspace record, so the same bytes round-trip through either API style.
- `capabilities()` reports `persistence` of `'local'` for the `local` area, `'remote'` for `sync` and `managed`, and `'ephemeral'` for `session`; `readAfterWrite: 'session'`, `scanConsistency: 'best-effort'`, and no `atomicBatch`, `conditionalBatch`, or `boundedRangeDelete`. `assertDurableStorageForRecovery()` rejects it.
- `batch()` rewrites the keyspace in one storage-area write under an in-process lock. There is no native compare-and-swap, and scans are best-effort across extension contexts.
- Writes to the `managed` area are rejected, and a `sync` write that would exceed the area's per-item or total quota fails before anything is written.

## Hand it to Weft or Bureau

Weft and Bureau take a `Storage` you construct. Pass this one to `new Engine({ storage })` from `@lostgradient/weft`, or to Bureau's `storage` option.

## Test it

The package runs the shared contract from `@lostgradient/storage/testing` against `WebExtensionStorage` over an injected in-memory storage area, plus tests for namespace resolution, callback-style APIs, quotas, and the managed area. `bun run test:coverage` fails below the line and function coverage of its own files that they had under Weft's coverage run before they moved here.

`src/web-extension-browser.test.ts` loads an unpacked Manifest V3 extension into a real Chromium through Playwright and round-trips bytes through the real `chrome.storage.local`. It is opt-in, because a browser launch competes for the machine's CPU: run `bunx playwright install chromium` once, then `bun run --filter=@lostgradient/storage-web-extension test:browser`, which sets `WEFT_BROWSER_SMOKE=1`. Without the variable the suite is skipped.
