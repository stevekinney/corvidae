# Session Management

Maintain conversation context and user sessions across tool executions.

```typescript file=session-management.ts
import { createToolbox, createTool } from 'armorer';
import { z } from 'zod';

// Session store interface
export interface Session {
  id: string;
  userId: string;
  conversationHistory: Array<{ role: string; content: string }>;
  toolInvocations: Array<{ name: string; timestamp: number }>;
  metadata: Record<string, unknown>;
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(userId: string): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      userId,
      conversationHistory: [],
      toolInvocations: [],
      metadata: {},
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  patchSession(sessionId: string, updates: Partial<Session>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      Object.assign(session, updates);
    }
  }

  addMessage(sessionId: string, role: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.conversationHistory.push({ role, content });
    }
  }

  trackToolInvocation(sessionId: string, toolName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.toolInvocations.push({ name: toolName, timestamp: Date.now() });
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// Create session-aware tool
const getUserPreferences = createTool({
  name: 'get-user-preferences',
  description: 'Get user preferences from session',
  input: z.object({ sessionId: z.string() }),
  async execute({ sessionId }, context) {
    const { sessionManager } = context as typeof context & { sessionManager: SessionManager };
    const session = sessionManager.getSession(sessionId);
    return session?.metadata['preferences'] ?? {};
  },
});

// Create session-aware toolbox
export const sessionManager = new SessionManager();

const toolbox = createToolbox([getUserPreferences], {
  context: { sessionManager },
  policy: {
    async beforeExecute(context) {
      const { sessionId } = context.params as { sessionId?: string };
      if (!sessionId) {
        return { allow: false, reason: 'Missing sessionId' };
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        return { allow: false, reason: 'Invalid session' };
      }

      // Track tool invocation
      sessionManager.trackToolInvocation(sessionId, context.toolName);
      return { allow: true };
    },
  },
});

// Usage
const session = sessionManager.createSession('user-123');
session.metadata['preferences'] = { theme: 'dark', language: 'en' };

const result = await toolbox.execute({
  name: 'get-user-preferences',
  arguments: { sessionId: session.id },
});
```

## Session Middleware

Automatically inject session context into all tools:

```typescript
import { createMiddleware, createTool, createToolbox } from 'armorer';
import { z } from 'zod';
import { sessionManager, type Session, type SessionManager } from './session-management.ts';

function createSessionMiddleware(sessionManager: SessionManager) {
  return createMiddleware((toolConfiguration) => {
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: any, context: any) {
        // Extract session ID from params
        const sessionId = params?.sessionId;
        if (!sessionId) {
          throw new Error('Session ID required');
        }

        const session = sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Invalid session');
        }

        // Inject session into context
        const enhancedContext = {
          ...context,
          session,
        };

        const executeFn =
          typeof originalExecute === 'function' ? originalExecute : await originalExecute;

        return executeFn(params, enhancedContext);
      },
    };
  });
}

// Usage
const tool = createTool({
  name: 'session-aware-tool',
  description: 'Access session automatically',
  input: z.object({
    sessionId: z.string(),
    action: z.string(),
  }),
  async execute({ action }, context) {
    const { session } = context as typeof context & { session: Session };
    console.log(`User ${session.userId} performed: ${action}`);
    return { success: true };
  },
});

const toolbox = createToolbox([tool], {
  middleware: [createSessionMiddleware(sessionManager)],
});
```
