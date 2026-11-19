/**
 * What Run again does for a run, and whether it can (COR-2424, rows 54e, 54f, 55f, 55j): a run a
 * chat started opens a new chat with the same agent and the message that started it, a run a
 * schedule started starts the schedule now, an instance of a workflow file sets up another run of the
 * workflow, and a goal's attempt has no Run again at all because the goal owns rerunning. A run that
 * needs a model while no provider is connected cannot start: Run again is held, and a link to
 * Settings › Models says why.
 *
 * Pure, so each kind of run is a row in a table test and the page only hands it what it has read.
 */
import type { TaskView } from '../../../lib/bureau-tasks.ts';
import { isBuiltInWorkflow } from '../../../lib/workflow-type-name.ts';
import { workflowRunSetupPath } from '../../../lib/workflow-type-paths.ts';
import { newChatPath } from '../../agents/agent-presentation.ts';

/** What Run again does when it is chosen. */
export type RunAgainKind =
  /** Opens a page: a new chat, or the form that sets up another run of a workflow. */
  | { readonly kind: 'open'; readonly href: string }
  /** Starts the schedule that started the run, now. */
  | { readonly kind: 'schedule'; readonly scheduleId: string };

/** What the page has read of the run, which decides what Run again is. */
export type RunAgainInput = {
  /** Whether the run is over: a run still going has nothing to run again. */
  readonly over: boolean;
  /** Whether the run is a goal's attempt, which the goal reruns. */
  readonly goalAttempt: boolean;
  /** The Bureau's task, when the run is one. */
  readonly task?: Pick<TaskView, 'kind' | 'agentName' | 'origin'> | undefined;
  /** The message that started a chat's run, when the chat's thread says it. */
  readonly messageIn?: string | undefined;
  /** The workflow an instance of a workflow file ran, when the run is no task. */
  readonly workflowType?: string | undefined;
};

/** The schedule a task was started by, from the origin the Bureau recorded with it. */
function scheduleOf(origin: TaskView['origin'] | undefined): string | undefined {
  if (origin === null || origin === undefined || origin.kind !== 'schedule') return undefined;
  const id: unknown = Reflect.get(origin, 'scheduleId');
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/** What Run again does for the run, or `undefined` when the run has no Run again. */
export function runAgainOf(input: RunAgainInput): RunAgainKind | undefined {
  if (!input.over || input.goalAttempt) return undefined;
  const { task } = input;
  if (task !== undefined) {
    const scheduleId = scheduleOf(task.origin);
    if (scheduleId !== undefined) return { kind: 'schedule', scheduleId };
    if (task.kind === 'chat' && task.agentName !== null) {
      const message = input.messageIn;
      const href = newChatPath(task.agentName);
      return {
        kind: 'open',
        href:
          message === undefined || message === ''
            ? href
            : `${href}&about=${encodeURIComponent(message)}`,
      };
    }
    return undefined;
  }
  const type = input.workflowType;
  if (type === undefined || isBuiltInWorkflow(type)) return undefined;
  return { kind: 'open', href: workflowRunSetupPath(type) };
}

/**
 * Whether Run again is held for want of a model provider: no provider is connected and one of the
 * agents the run uses names a model. An agent that is scripted, or whose definition could not be
 * read, never holds it, so Run again is not said to be blocked on a guess.
 */
export function runAgainBlocked(input: {
  readonly noProvider: boolean;
  readonly agents: readonly string[];
  readonly modelAgents: ReadonlySet<string>;
}): boolean {
  return input.noProvider && input.agents.some((agent) => input.modelAgents.has(agent));
}
