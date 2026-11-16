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
 * @module host-panel-operations
 */

/**
 * The operation names a host panel may declare in `hostOnlyTools`: the workflow-revision review
 * applies an approved revision with `bureau.workflows.update`.
 */
export const HOST_PANEL_OPERATIONS: ReadonlySet<string> = new Set(['bureau.workflows.update']);
