/**
 * The application fixtures in `fixtures/`, by component, that chat's browser suite serves. The
 * root suite (`scripts/browser-fixtures`) serves them too, so its component sweep covers them.
 */
export const chatAppFixtureDeclarations = {
  chat: ['assertion'],
  'chat-mcp-app': ['assertion'],
  'chat-mcp-app-fill': ['assertion'],
  'chat-conversation-list': ['assertion'],
  'conversation-markdown': ['assertion'],
  'a2ui-a2a-part': ['assertion'],
  'a2ui-surface': ['assertion'],
  'chat-composer-popover': ['assertion'],
  'chat-conversation-header': ['assertion'],
  'chat-navigation-rail': ['assertion'],
  'chat-stress': ['assertion'],
  'chat-sub-session': ['assertion'],
} as const satisfies Record<string, readonly string[]>;
