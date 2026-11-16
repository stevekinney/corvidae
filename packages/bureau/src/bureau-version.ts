/**
 * The version Bureau reports about itself where a record names what Bureau contributed, such as
 * the source of a validator the host gave the Bureau (COR-2111). No workspace `package.json`
 * carries a version, and nothing else in Bureau reports one (the MCP server info, the A2A card and
 * the deployment read name none), so it is a constant here. Change it when Bureau's own
 * contributions change in a way a record that names them must tell apart. It is not
 * `BUREAU_PLUGIN_VERSION`, which pins what a recorded tool call may resume across.
 */
export const BUREAU_VERSION = '0.1.0';
