/**
 * The application fixtures in `fixtures/`, by component, that chat's browser suite serves. The
 * root suite (`scripts/browser-fixtures`) serves them too, so its component sweep covers them.
 */
export const chatAppFixtureDeclarations = {
  chat: ['assertion'],
  'chat-mcp-app': ['assertion'],
  'chat-conversation-list': ['assertion'],
  'conversation-markdown': ['assertion'],
} as const satisfies Record<string, readonly string[]>;
