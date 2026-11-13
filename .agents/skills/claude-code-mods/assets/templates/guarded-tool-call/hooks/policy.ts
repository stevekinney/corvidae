/**
 * Pure policy for protected-paths: no `$`, so every rule is unit-testable.
 *
 * These rules are reminders that steer Claude, not a security boundary. A
 * determined process can reach the same files another way (a shell command, a
 * different tool, a mod's own `$.fs`), so protect what matters with operating
 * system permissions, branch protection, or a policy your organization manages.
 */

const EXAMPLE_ENVIRONMENT_FILES = new Set(['.env.example', '.env.sample', '.env.template']);

function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Why one spelling of a path is protected, or `undefined` when it is not. */
function reasonForSpelling(path: string): string | undefined {
  const segments = segmentsOf(path);
  const name = segments.at(-1) ?? '';
  if ((name === '.env' || name.startsWith('.env.')) && !EXAMPLE_ENVIRONMENT_FILES.has(name)) {
    return `${name} holds environment secrets`;
  }
  if (segments.slice(0, -1).includes('.git')) {
    return 'files inside .git are managed by git itself';
  }
  return undefined;
}

/**
 * Why a write to `path` is refused, or `undefined` when it may go ahead.
 * `realPath` is where the path lands with every link followed, when the file
 * exists; both spellings are judged so a link cannot hide a protected file.
 */
export function protectedReason(path: string, realPath: string | undefined): string | undefined {
  return (
    reasonForSpelling(path) ?? (realPath === undefined ? undefined : reasonForSpelling(realPath))
  );
}

const RISKY_COMMANDS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, label: 'recursive delete' },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: 'hard reset' },
  { pattern: /\bgit\s+push\b.*(\s--force(-with-lease)?\b|\s-f\b)/, label: 'force push' },
  { pattern: /\bgit\s+clean\b.*\s-[a-zA-Z]*f/, label: 'git clean' },
];

/** A short label for a risky shell command, or `undefined` for any other. */
export function riskOf(command: string): string | undefined {
  return RISKY_COMMANDS.find((risky) => risky.pattern.test(command))?.label;
}

/** The outcome of a `tool.call`, read from what `next(e)` resolved to. */
export function outcomeOf(result: { readonly deny?: unknown; readonly isError?: unknown }): string {
  if (typeof result.deny === 'string') return 'refused';
  if (result.isError === true) return 'failed';
  return 'succeeded';
}
