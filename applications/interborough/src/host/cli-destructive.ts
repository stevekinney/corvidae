import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

/**
 * One command action that cancels, pauses, disables, removes or deletes something (COR-2523).
 * Every one accepts `--dry-run`; `confirms` says whether it also asks first.
 */
export type CliDestructiveAction = {
  /** What the command does, in the words of a confirmation: `Delete chat`. */
  readonly subject: string;
  /**
   * The operations and host routes the action can send, as `CLI_OPERATION_MAPPINGS` names them;
   * empty for `api call`, which sends whatever operation it is given.
   */
  readonly operations: readonly string[];
  /**
   * - `always`: the action cannot be undone, so it asks on a terminal and refuses without one,
   *   unless `--yes` is given.
   * - `destructive-operation`: `api call` asks only for an operation the catalog marks destructive.
   * - `never`: a safety stop, or a change that is reversible, so it runs without asking.
   */
  readonly confirms: 'always' | 'destructive-operation' | 'never';
};

/**
 * The actions the CLI can preview, by `<command> <action>`. The guard is `cli-destructive.test.ts`:
 * a command mapped to a destructive operation that is missing here, or whose registry entry lacks
 * `--dry-run`, or that is neither confirmed nor on the unconfirmed list, fails it.
 */
export const CLI_DESTRUCTIVE_ACTIONS: Readonly<Record<string, CliDestructiveAction>> =
  Object.freeze({
    'runs cancel': {
      subject: 'Cancel run',
      operations: ['bureau.tasks.cancel', 'weft.workflows.cancel'],
      confirms: 'never',
    },
    'chats cancel': {
      subject: 'Cancel chat run',
      operations: ['POST /bureau/ag-ui/runs/:run/cancel', 'bureau.tasks.cancel'],
      confirms: 'never',
    },
    'goals cancel': {
      subject: 'Cancel goal',
      operations: ['bureau.goals.cancel'],
      confirms: 'never',
    },
    'schedules pause': {
      subject: 'Pause schedule',
      operations: ['bureau.schedules.pause'],
      confirms: 'never',
    },
    'plugins disable': {
      subject: 'Disable plugin',
      operations: ['PUT /host/plugins/:plugin'],
      confirms: 'never',
    },
    'chats delete': {
      subject: 'Delete chat',
      operations: ['bureau.contexts.delete'],
      confirms: 'always',
    },
    'agents delete': {
      subject: 'Delete agent',
      operations: ['bureau.agents.definitions.delete'],
      confirms: 'always',
    },
    'hooks delete': {
      subject: 'Delete hook',
      operations: ['bureau.hooks.delete'],
      confirms: 'always',
    },
    'memory forget': {
      subject: 'Forget memory',
      operations: ['bureau.memory.forget'],
      confirms: 'always',
    },
    'tool-sources remove': {
      subject: 'Remove tool source',
      operations: ['DELETE /host/tool-sources/:id'],
      confirms: 'always',
    },
    'providers disconnect': {
      subject: 'Disconnect provider',
      operations: ['DELETE /host/providers/:provider'],
      confirms: 'always',
    },
    'api call': { subject: 'Run operation', operations: [], confirms: 'destructive-operation' },
  } satisfies Record<string, CliDestructiveAction>);

/** `<command> <action>` for a parsed command, the key of {@link CLI_DESTRUCTIVE_ACTIONS}. */
function destructiveActionName(parsed: Parsed): string {
  return `${parsed.command} ${parsed.arguments[0] ?? ''}`;
}

/** Whether `parsed` names an action that can be previewed. */
export function isDestructiveAction(command: string, action: string | undefined): boolean {
  return Object.hasOwn(CLI_DESTRUCTIVE_ACTIONS, `${command} ${action ?? ''}`);
}

/** Whether the command asked for a preview. */
export function isDryRun(parsed: Parsed): boolean {
  return parsed.options.get('dry-run') === true;
}

/**
 * Ask before an action that cannot be undone. `--yes` confirms. Without it, a terminal gets a
 * prompt that defaults to no, and anything else (input is not a terminal, or `--no-input`) is
 * refused with the usage exit status, changing nothing: weft's `confirmDestructive`, with the
 * terminal and the prompt injected as `CliClientDependencies` has them.
 */
export async function confirmIrreversible(
  parsed: Parsed,
  dependencies: CliClientDependencies,
  subject: string,
): Promise<void> {
  if (parsed.options.get('yes') === true) return;
  const prompt = dependencies.prompt;
  if (parsed.noInput || dependencies.stdinIsTTY !== true || prompt === undefined)
    throw Object.assign(
      new Error(`${subject} cannot be undone and input is not a terminal; pass --yes to confirm.`),
      { usage: true, exitCode: 2 },
    );
  const answer = await prompt(`${subject}? This cannot be undone. [y/N] `, dependencies.signal);
  if (!answer.trim().toLowerCase().startsWith('y'))
    throw Object.assign(new Error('Cancelled; nothing was changed.'), { exitCode: 1 });
}

/** The gate every action in {@link CLI_DESTRUCTIVE_ACTIONS} passes before it sends anything. */
export async function gateDestructiveAction(
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<void> {
  const action = CLI_DESTRUCTIVE_ACTIONS[destructiveActionName(parsed)];
  if (action === undefined || action.confirms !== 'always' || isDryRun(parsed)) return;
  const target = parsed.arguments[1];
  await confirmIrreversible(
    parsed,
    dependencies,
    target === undefined ? action.subject : `${action.subject} ${target}`,
  );
}

/**
 * The answer to `--dry-run` for a change the host or Bureau cannot preview itself: the CLI read the
 * target, and says what it would send. It states that it made the preview, and nothing was sent.
 */
export function cliPreview(input: {
  readonly target: { readonly kind: string; readonly id: string };
  readonly current?: Record<string, unknown>;
  readonly wouldSend: Record<string, unknown>;
}): CliCommandResult {
  return {
    data: {
      dryRun: true,
      previewedBy: 'cli',
      note: 'The CLI made this preview from the target as it is now: the server has no dry run for this change, and nothing was sent to change it.',
      target: input.target,
      ...(input.current === undefined ? {} : { current: input.current }),
      wouldSend: input.wouldSend,
    },
  };
}

/** The name of a target that was not found, as the failure a dry run exits with. */
export function previewTargetNotFound(kind: string, id: string): Error {
  return Object.assign(new Error(`${kind} ${id} was not found.`), { exitCode: 1, status: 404 });
}
