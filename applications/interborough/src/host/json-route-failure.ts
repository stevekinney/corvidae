import { randomUUID } from 'node:crypto';

type JsonRouteFailureOptions = {
  readonly log?: ((message: string) => void) | undefined;
  readonly method: string;
  readonly route: string;
  readonly message: string;
};

/** Answer an unexpected JSON route failure without exposing the exception or request contents. */
export function unexpectedJsonRouteFailure({
  log,
  method,
  route,
  message,
}: JsonRouteFailureOptions): Response {
  const requestId = randomUUID();
  log?.(JSON.stringify({ event: 'host.json.failure', requestId, method, route }));
  return Response.json({ error: 'failed', message, requestId }, { status: 500 });
}
