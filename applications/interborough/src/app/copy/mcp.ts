/**
 * The words of Settings › MCP (COR-2539): where Interborough's MCP endpoint is and how to point a
 * coding agent or any MCP client at it. The page teaches the connection and nothing else (no sample
 * agents, no sample content), and it shows no credential because the endpoint needs none.
 */
export const MCP_COPY = {
  intro: 'Connect a coding agent or any MCP client to this Interborough.',
  groupLabel: 'MCP connection',
  endpoint: {
    heading: 'Endpoint address',
    description:
      'The MCP server Interborough serves. A client that connects here can call the operations the pages use. It needs no sign-in: the host listens on this computer only.',
    copy: 'Copy the MCP address',
    copied: 'Copied the MCP address',
  },
  claudeCode: {
    heading: 'Claude Code',
    description: 'Run this once in a terminal to add Interborough to Claude Code.',
    copy: 'Copy the Claude Code command',
  },
  generic: {
    heading: 'Other MCP clients',
    /** The words around the file name, which the page draws in code. The copy holds no markup. */
    description: {
      before: 'Add this to the MCP servers your client reads, such as an ',
      file: '.mcp.json',
      after: ' file. It uses the HTTP transport.',
    },
    copy: 'Copy the MCP client configuration',
  },
} as const;
