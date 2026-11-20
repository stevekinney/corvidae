/**
 * How a coding agent or an MCP client connects to Interborough (COR-2539). Interborough's own MCP
 * endpoint is Bureau's, mounted at `/bureau/mcp`; it is not Weft's `/mcp`, which serves the engine's
 * operations. The endpoint needs no credential: the host listens on loopback and serves every caller
 * as `anonymous:local`, so nothing here names a key, a token or a header.
 *
 * One function builds each shape, and every place that shows a connection takes it from here: the
 * start lines (`src/host/connection-details.ts`), `interborough mcp` (`src/host/cli-mcp.ts`),
 * Settings › MCP, and the Claude Code smoke test (`scripts/smoke-claude-code-mcp.ts`), which runs the
 * same arguments against a real `claude`. The module reads no platform API, so the browser
 * application imports it too.
 *
 * @module mcp-connection
 */

/** Where Bureau's MCP endpoint is, on the host's origin. */
export const MCP_PATH = '/bureau/mcp';

/** The name a coding agent registers Interborough's MCP server under. */
export const MCP_SERVER_NAME = 'interborough';

/** The scopes `claude mcp add --scope` takes: `local` is its default. */
export type ClaudeCodeScope = 'local' | 'user' | 'project';

/** The MCP endpoint on `origin`, such as `http://127.0.0.1:7234/bureau/mcp`. */
export function mcpEndpoint(origin: string | URL): string {
  return new URL(MCP_PATH, origin).href;
}

/**
 * The arguments that follow `claude` to register `endpoint` as an HTTP MCP server named `name`:
 * `mcp add --transport http <name> <endpoint>`, and `-s <scope>` when a scope is named. Without one
 * Claude Code uses its own default, `local`. Checked against Claude Code 2.1.316, whose `claude mcp
 * add` writes `{ "type": "http", "url": <endpoint> }` under `mcpServers.<name>`.
 */
export function claudeCodeAddArguments(
  name: string,
  endpoint: string,
  scope?: ClaudeCodeScope,
): string[] {
  return [
    'mcp',
    'add',
    '--transport',
    'http',
    name,
    endpoint,
    ...(scope === undefined ? [] : ['-s', scope]),
  ];
}

/** One argument as a shell reads it back: bare when it holds only safe characters, else single-quoted. */
function shellWord(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", `'\\''`)}'`;
}

/** The command a person pastes into a terminal to register `endpoint` with Claude Code. */
export function claudeCodeAddCommand(
  name: string,
  endpoint: string,
  scope?: ClaudeCodeScope,
): string {
  return ['claude', ...claudeCodeAddArguments(name, endpoint, scope)].map(shellWord).join(' ');
}

/**
 * The server entry an MCP client that reads `mcpServers` (Claude Code's `.mcp.json`, and the many
 * clients that copy its shape) takes for `endpoint`: `{ "type": "http", "url": <endpoint> }`.
 */
export function genericMcpConfiguration(
  name: string,
  endpoint: string,
): {
  readonly mcpServers: Readonly<Record<string, { readonly type: 'http'; readonly url: string }>>;
} {
  return { mcpServers: { [name]: { type: 'http', url: endpoint } } };
}

/** Everything a person needs to connect a coding agent or an MCP client to the host at `origin`. */
export type McpConnection = {
  /** The server name the shown configurations register. */
  readonly name: string;
  /** The MCP endpoint's address. */
  readonly endpoint: string;
  /** The Claude Code registration: the command to paste, and the arguments after `claude`. */
  readonly claudeCode: { readonly command: string; readonly arguments: readonly string[] };
  /** The `mcpServers` entry for any other MCP client, as an object and as the text to copy. */
  readonly generic: {
    readonly configuration: ReturnType<typeof genericMcpConfiguration>;
    readonly text: string;
  };
};

/** The connection details for the host at `origin`, with no credential in any of them. */
export function mcpConnection(origin: string | URL, name: string = MCP_SERVER_NAME): McpConnection {
  const endpoint = mcpEndpoint(origin);
  const configuration = genericMcpConfiguration(name, endpoint);
  return {
    name,
    endpoint,
    claudeCode: {
      command: claudeCodeAddCommand(name, endpoint),
      arguments: claudeCodeAddArguments(name, endpoint),
    },
    generic: { configuration, text: JSON.stringify(configuration, null, 2) },
  };
}
