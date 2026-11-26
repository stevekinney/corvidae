import { Miniflare } from 'miniflare';

/** The shared compatibility date for every Corvidae workerd integration suite. */
export const WORKERD_COMPATIBILITY_DATE = '2026-08-06';

export type OutboundService = (request: Request) => Response | Promise<Response>;

export type WorkerOptions = {
  entry: string;
  assets?: string;
  durableObjects?: Record<string, string>;
  d1Databases?: readonly string[];
  outboundService?: OutboundService;
};

export type WorkerBindings = {
  dispatchFetch: Miniflare['dispatchFetch'];
  getD1Database(binding: string): ReturnType<Miniflare['getD1Database']>;
  getDurableObjectNamespace(binding: string): ReturnType<Miniflare['getDurableObjectNamespace']>;
  outboundService: OutboundService | undefined;
};

/**
 * Bundle an entry point and run it under workerd through Miniflare.
 *
 * Each invocation owns its Miniflare instance, so durable and D1 state is shared only by the
 * requests made inside its callback. The instance is always disposed before this function settles.
 */
export async function withWorker<T>(
  options: WorkerOptions,
  callback: (bindings: WorkerBindings) => Promise<T>,
): Promise<T> {
  const build = await Bun.build({
    entrypoints: [options.entry],
    target: 'browser',
    conditions: ['workerd', 'worker', 'browser'],
    format: 'esm',
    external: ['node:*'],
  });
  if (!build.success) {
    throw new AggregateError(build.logs, `Unable to bundle Worker entry ${options.entry}`);
  }
  const script = await build.outputs[0]!.text();
  const miniflare = new Miniflare({
    name: 'test-worker',
    modules: [{ type: 'ESModule', path: options.entry, contents: script }],
    compatibilityDate: WORKERD_COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    ...(options.assets === undefined
      ? {}
      : {
          assets: {
            directory: options.assets,
            binding: 'ASSETS',
            workerName: 'test-worker',
            routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
          },
        }),
    ...(options.durableObjects === undefined ? {} : { durableObjects: options.durableObjects }),
    ...(options.d1Databases === undefined ? {} : { d1Databases: [...options.d1Databases] }),
    ...(options.outboundService === undefined ? {} : { outboundService: options.outboundService }),
  });
  try {
    return await callback({
      dispatchFetch: miniflare.dispatchFetch.bind(miniflare),
      getD1Database: miniflare.getD1Database.bind(miniflare),
      getDurableObjectNamespace: miniflare.getDurableObjectNamespace.bind(miniflare),
      outboundService: options.outboundService,
    });
  } finally {
    await miniflare.dispose();
  }
}
