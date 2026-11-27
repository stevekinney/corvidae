import type { NodeHost, ServeOptions } from '@lostgradient/node-host';
import type { CreateWorker } from './workers/pool.ts';

/** Creates Bun's Web Worker implementation without leaking it into the portable entry. */
export const bunWorkerFactory: CreateWorker = (url, options) => new Worker(url, options);

/** Starts Weft on Bun. Kept out of the portable root entry point. */
export function bunServerHost<Data>(options: ServeOptions<Data>): NodeHost<Data> {
  return Bun.serve(options as never) as unknown as NodeHost<Data>;
}
