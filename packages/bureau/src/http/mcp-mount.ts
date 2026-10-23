import { createOperationMcpMount, type OperationHandlerMount } from '@lostgradient/weft';

/**
 * Options for the Bureau MCP adapter that `createBureauHandler`'s `mcp`
 * option mounts (COR-839).
 */
export type BureauMcpOptions = {
  /** The path the adapter owns. Defaults to `/mcp`. */
  readonly pathPrefix?: string;
};

/**
 * Serve Bureau's `mcpExposable` catalog operations as MCP tools, beside the
 * catalog. v1 ("observe and steer") exposes the reads and the four steering
 * commands a host such as Claude Desktop or Claude Code uses to follow and
 * answer existing work: list and inspect agents, contexts, tasks and their
 * events, reviews, goals, schedules and workflow runs; send input to a context,
 * respond to or cancel a task, and resolve a review. Nothing here starts a run.
 *
 * Every tool call runs through the catalog pipeline as the caller the handler
 * authenticated, so the access policy and each operation's owner predicate
 * apply exactly as they do on `POST /jsonrpc`. Long-running work answers with
 * its task locator; a client follows it with `bureau.tasks.get` and
 * `bureau.tasks.events`, which answers with the events recorded after its
 * `fromCursor` and the cursor to resume from.
 */
export function createBureauMcpMount(
  options: BureauMcpOptions,
  maxBodyBytes: number | undefined,
): OperationHandlerMount {
  return createOperationMcpMount({
    ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    serverInfo: { name: 'bureau', title: 'Bureau' },
  });
}
