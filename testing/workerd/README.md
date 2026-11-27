# `@lostgradient/workerd-testing`

`withWorker` bundles a Worker entry with Bun using the `workerd`, `worker`, and `browser` conditions, then runs it in Miniflare's workerd runtime. The helper uses the shared `WORKERD_COMPATIBILITY_DATE` and enables `nodejs_compat` for every Worker.

```ts
await withWorker(
  { entry: new URL('./worker.ts', import.meta.url).pathname, d1Databases: ['DB'] },
  async ({ dispatchFetch }) => {
    const response = await dispatchFetch('https://example.test/');
  },
);
```

Pass `durableObjects` to name Durable Object classes, `assets` to bind a static-assets directory as `ASSETS`, `r2Buckets` to bind named R2 buckets, and `outboundService` to stub outbound fetches. The callback also receives D1, R2, and Durable Object binding accessors. A library adds a `*.integration.test.ts` suite that imports its Worker-facing export, exercises it through `withWorker`, and runs it from its `test:slow` script.
