import { systemClock, type SessionClock } from '../session/session-clock.ts';
import type { OutputSource, ProcessBackend } from '../session/session-types.ts';
import { isSupportedHost, type HostPlatform } from './host-platform.ts';
import { OwnedProcess } from './owned-process.ts';
import { processGroupOperations, readProcessTable } from './process-group.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import {
  PROCESS_BUDGETS,
  type HostedProcess,
  type ProcessExitReceiver,
  type ProcessHostOptions,
  type SpawnedProcess,
  type SpawnProcess,
} from './process-types.ts';
import { validateWholeNumber } from './process-validation.ts';

/** The host options after validation, with every default applied. */
export type ResolvedHostSettings = {
  readonly host: HostPlatform;
  readonly spawn: SpawnProcess;
  readonly clock: SessionClock;
  readonly graceMilliseconds: number;
  readonly observationMilliseconds: number;
  readonly maximumBufferedOutputBytes: number;
};

/** Validate the host options and fill in the defaults. A setting outside its range is refused, never clamped. */
export function resolveHostSettings(options: ProcessHostOptions): ResolvedHostSettings {
  const settled = (label: keyof typeof PROCESS_BUDGETS, value: number | undefined): number => {
    const budget = PROCESS_BUDGETS[label];
    const resolved = value ?? budget.default;
    validateWholeNumber(label, resolved, budget.minimum, budget.maximum);
    return resolved;
  };
  return {
    host: options.host ?? { platform: process.platform, architecture: process.arch },
    spawn: options.spawn ?? ((command, spawnOptions) => Bun.spawn(command, spawnOptions as never)),
    clock: options.clock ?? systemClock,
    graceMilliseconds: settled(
      'terminationGraceMilliseconds',
      options.terminationGraceMilliseconds,
    ),
    observationMilliseconds: settled(
      'observationWindowMilliseconds',
      options.observationWindowMilliseconds,
    ),
    maximumBufferedOutputBytes: settled(
      'maximumBufferedOutputBytes',
      options.maximumBufferedOutputBytes,
    ),
  };
}

export function createOwnedProcess(settings: ResolvedHostSettings): OwnedProcess {
  return new OwnedProcess({
    operations: processGroupOperations,
    clock: settings.clock,
    graceMilliseconds: settings.graceMilliseconds,
    observationMilliseconds: settings.observationMilliseconds,
    readProcessTable,
  });
}

/**
 * Check the host against the supported matrix, then spawn. A host outside the matrix is
 * `unsupported-runtime`, for a pipe as much as a PTY, and is never retried in another mode; a spawn
 * the operating system refuses, such as a missing executable or working directory, is `spawn-failed`.
 */
export function spawnOwnedProcess(
  settings: ResolvedHostSettings,
  command: string[],
  spawnOptions: Record<string, unknown>,
): SpawnedProcess {
  const { platform, architecture } = settings.host;
  if (!isSupportedHost(settings.host)) {
    throw new ProcessStartFailure(
      'unsupported-runtime',
      `terminal processes run on macOS and Linux, on x64 and arm64; this host is ${platform}/${architecture}`,
    );
  }
  try {
    return settings.spawn(command, spawnOptions);
  } catch (cause) {
    throw new ProcessStartFailure('spawn-failed', `could not spawn ${command[0]}`, { cause });
  }
}

/** Build the `HostedProcess` a session consumes from the pieces each mode assembles. */
export function assembleHostedProcess(parts: {
  readonly mode: 'pipe' | 'pty';
  readonly backend: ProcessBackend;
  readonly sources: readonly OutputSource[];
  readonly owned: OwnedProcess;
  readonly startFailure: () => ProcessStartFailure | undefined;
}): HostedProcess {
  const { mode, backend, sources, owned, startFailure } = parts;
  return {
    mode,
    backend,
    sources,
    get startFailure() {
      return startFailure();
    },
    async reportExitTo(receiver: ProcessExitReceiver): Promise<void> {
      await receiver.start();
      const exit = await owned.exit;
      if (exit !== undefined) receiver.reportProcessExit(exit.exitCode, exit.signal);
    },
  };
}
