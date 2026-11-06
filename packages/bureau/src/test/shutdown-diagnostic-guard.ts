/** Detect unexpected process-lease cleanup failures without hiding their diagnostics. */
export function createShutdownDiagnosticGuard(forward: (...values: unknown[]) => void) {
  const failures: string[] = [];

  return {
    error(...values: unknown[]): void {
      forward(...values);
      const message = values[0];
      if (
        typeof message === 'string' &&
        message.startsWith('[bureau] Could not remove the process lease:')
      ) {
        failures.push(message);
      }
    },
    assertClean(): void {
      if (failures.length > 0) {
        throw new Error(`Bureau process-lease cleanup failed:\n${failures.join('\n')}`);
      }
    },
  };
}
