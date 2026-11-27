import { Miniflare } from 'miniflare';

/** The shared compatibility date for every Corvidae workerd integration suite. */
export const WORKERD_COMPATIBILITY_DATE = '2026-08-06';

export type OutboundService = (request: Request) => Response | Promise<Response>;

export type WorkerOptions = {
  entry: string;
  assets?: string;
  durableObjects?: Record<string, string>;
  d1Databases?: readonly string[];
  r2Buckets?: readonly string[];
  outboundService?: OutboundService;
};

export type WorkerBindings = {
  dispatchFetch: Miniflare['dispatchFetch'];
  getD1Database(binding: string): ReturnType<Miniflare['getD1Database']>;
  getR2Bucket(binding: string): ReturnType<Miniflare['getR2Bucket']>;
  getDurableObjectNamespace(binding: string): ReturnType<Miniflare['getDurableObjectNamespace']>;
  outboundService: OutboundService | undefined;
};

/** A running local workerd instance and the bindings its Worker receives. */
export type RunningWorker = WorkerBindings & {
  dispose(): Promise<void>;
};

/** Bundle an entry point and start it under workerd through Miniflare. The caller owns disposal. */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
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
    ...(options.r2Buckets === undefined ? {} : { r2Buckets: [...options.r2Buckets] }),
    ...(options.outboundService === undefined ? {} : { outboundService: options.outboundService }),
  });
  return {
    dispatchFetch: miniflare.dispatchFetch.bind(miniflare),
    getD1Database: miniflare.getD1Database.bind(miniflare),
    getR2Bucket: miniflare.getR2Bucket.bind(miniflare),
    getDurableObjectNamespace: miniflare.getDurableObjectNamespace.bind(miniflare),
    outboundService: options.outboundService,
    dispose: () => miniflare.dispose(),
  };
}

/**
 * Bundle an entry point, run it under workerd, then dispose it after the callback settles.
 */
export async function withWorker<T>(
  options: WorkerOptions,
  callback: (bindings: WorkerBindings) => Promise<T>,
): Promise<T> {
  const worker = await startWorker(options);
  try {
    return await callback(worker);
  } finally {
    await worker.dispose();
  }
}
