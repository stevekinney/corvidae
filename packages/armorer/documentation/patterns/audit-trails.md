# Audit Trails

Track all tool executions for compliance and debugging.

```typescript file=audit-trails.ts
import { createMiddleware, createToolbox } from 'armorer';

export interface AuditEntry {
  timestamp: number;
  toolName: string;
  params: unknown;
  result?: unknown;
  error?: string;
  userId?: string;
  sessionId?: string;
  durationMs: number;
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    // Optionally persist to database
  }

  getEntries(filter?: Partial<AuditEntry>): AuditEntry[] {
    if (!filter) return this.entries;

    return this.entries.filter((entry) => {
      return Object.entries(filter).every(
        ([key, value]) => entry[key as keyof AuditEntry] === value,
      );
    });
  }

  export(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

// Create audit middleware
function createAuditMiddleware(auditLog: AuditLog) {
  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: any) {
        const startTime = Date.now();
        const entry: Partial<AuditEntry> = {
          timestamp: startTime,
          toolName,
          params,
          userId: context.userId,
          sessionId: context.sessionId,
        };

        try {
          const executeFn =
            typeof originalExecute === 'function' ? originalExecute : await originalExecute;

          const result = await executeFn(params, context);

          entry.result = result;
          entry.durationMs = Date.now() - startTime;
          auditLog.log(entry as AuditEntry);

          return result;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
          entry.durationMs = Date.now() - startTime;
          auditLog.log(entry as AuditEntry);

          throw error;
        }
      },
    };
  });
}

// Usage
const auditLog = new AuditLog();

export const toolbox = createToolbox([], {
  middleware: [createAuditMiddleware(auditLog)],
  context: {
    userId: 'user-123',
    sessionId: 'session-456',
  },
});

// Query audit log
const userActions = auditLog.getEntries({ userId: 'user-123' });
console.log(`User performed ${userActions.length} actions`);

// Export for compliance
const exportedLog = auditLog.export();
```

## Audit Trail with Events

```typescript
import { AuditLog, toolbox, type AuditEntry } from './audit-trails.ts';

// Use toolbox events for audit trail
const auditLog = new AuditLog();

toolbox.addEventListener('tool.started', (event) => {
  console.log(`[AUDIT] Started: ${event.toolCall.name}`);
});

toolbox.addEventListener('tool.finished', (event) => {
  const { toolCall, result, error, status, durationMs } = event;

  auditLog.log({
    timestamp: Date.now(),
    toolName: toolCall.name,
    params: toolCall.arguments,
    result: status === 'success' ? result : undefined,
    error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
    durationMs,
  } as AuditEntry);
});
```
