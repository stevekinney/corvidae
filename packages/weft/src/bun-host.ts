import type { NodeHost, ServeOptions } from '@lostgradient/node-host';

/** Starts Weft on Bun. Kept out of the portable root entry point. */
export function bunServerHost<Data>(options: ServeOptions<Data>): NodeHost<Data> {
  return Bun.serve(options as never) as unknown as NodeHost<Data>;
}
