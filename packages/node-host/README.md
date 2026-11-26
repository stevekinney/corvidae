# Node Host

`@lostgradient/node-host` provides the Corvidae subset of `Bun.serve` on Node 22 or later. Callers explicitly import and select this host.

```ts
import { serve } from '@lostgradient/node-host';

const server = serve({
  port: 3000,
  fetch: () => new Response('ok'),
});
```

The host supports `fetch`, exact-path `routes`, `port`, `hostname`, TLS `key` and `cert`, and WebSocket `open`, `message`, `close`, `drain`, `maxPayloadLength`, and `idleTimeout` handlers. The returned server exposes `ready` for Node's asynchronous bind, plus `upgrade`, `publish`, `requestIP`, `timeout`, and `stop`. Its sockets support `data`, `send`, `close`, `terminate`, topic subscriptions, and `readyState`.

It does not support any other `Bun.serve` option: `development`, `error`, `id`, `reusePort`, `unix`, `maxRequestBodySize`, TLS `ca`, `passphrase`, and reload, or Bun's full route grammar and per-route `fetch` parameters. HTTP/2 is outside this host's contract.
