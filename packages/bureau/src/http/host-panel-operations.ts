/**
 * The Bureau operations a host panel may reach through `hostOnlyTools` (COR-2208). A panel's
 * `hostOnlyTools` entry goes to the Bureau's `/jsonrpc` surface, which also answers operations marked
 * `mcpExposable: false`, so an entry outside this set could reach a destructive operation no MCP
 * client may call. Composition refuses such an entry, and the host answers 403 for it even when a
 * panel declared it.
 *
 * Adding a name here opens that operation to every host panel that declares it, so each addition
 * is a security review of the operation. The set is a constant in Bureau, not a field of Weft's
 * operation type, so Weft stays unaware of panels.
 *
 * A person is told apart from a model by the route and never by a flag: only the host's panel
 * routes reach `/jsonrpc` for these names, while an MCP client sees only operations that are
 * `mcpExposable`. The panel a call came through is attested the same way: the host's panel route
 * runs the call inside {@link runAsHostPanel}, an in-process scope no request header, parameter or
 * body can set, so an operation reads the panel's URI with {@link hostPanelUriOfCall} and an
 * outside caller can never forge it.
 *
 * @module host-panel-operations
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The operation names a host panel may declare in `hostOnlyTools`: the workflow-revision review
 * applies an approved revision with `bureau.workflows.update` (COR-2208), and the schedule editor
 * creates, changes, pauses and resumes a schedule (COR-2545). A schedule write stays
 * `mcpExposable: false`, so a model never sees it; the schedule editor is the one place a person
 * makes one of these writes from a panel.
 */
export const HOST_PANEL_OPERATIONS: ReadonlySet<string> = new Set([
  'bureau.workflows.update',
  'bureau.schedules.create',
  'bureau.schedules.update',
  'bureau.schedules.pause',
  'bureau.schedules.resume',
]);

const hostPanelCalls = new AsyncLocalStorage<string>();

/**
 * Runs `call`, the in-process dispatch of one host-only operation, as made through the host panel
 * `panelUri`. The host's panel route is the only caller. The scope lives in the call's own async
 * context, so it is never part of a request an outside client could write.
 */
export function runAsHostPanel<Result>(panelUri: string, call: () => Result): Result {
  return hostPanelCalls.run(panelUri, call);
}

/**
 * The `ui://` URI of the host panel the running call came through, or `undefined` for any call that
 * did not come through a host panel route.
 */
export function hostPanelUriOfCall(): string | undefined {
  return hostPanelCalls.getStore();
}
