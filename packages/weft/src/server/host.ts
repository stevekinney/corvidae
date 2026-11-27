import type { ServeOptions } from '@lostgradient/node-host';

/** Host operations Weft needs after a runtime binds its listener. */
export type ServerHandle<Data> = {
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly ready?: Promise<void> | undefined;
  publish(topic: string, message: string): number;
  requestIP(
    request: Request,
  ): { address: string; family: 'IPv4' | 'IPv6'; port: number } | null | undefined;
  stop(closeActiveConnections?: boolean): void;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options: { data: Data }): boolean;
};

/** The caller-selected runtime binding function. */
export type ServerHost<Data> = (options: ServeOptions<Data>) => ServerHandle<Data>;
