import type { TaskView } from '../../../lib/bureau-tasks.ts';

/**
 * Chooses the chat thread for a run's tool calls. Direct child tasks are catalog records whose
 * context id is a handle, not an AG-UI thread, so they use the explicit no-thread path.
 */
export function threadIdForTask(
  task: Pick<TaskView, 'kind' | 'origin'>,
  explicitThreadId: string | null | undefined,
): string | null | undefined {
  if (explicitThreadId !== undefined) return explicitThreadId;
  return task.kind === 'catalog' && task.origin?.kind === 'agent' ? null : undefined;
}
