import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';

import { verifiedGate } from './owned-process-lease.ts';
import { processStartTime } from './process-identity.ts';

export interface OwnedProcessGroupOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly token?: string;
  readonly register: (pid: number, startedAt: string) => Promise<void>;
  readonly started?: (pid: number, signal: (signal: NodeJS.Signals) => void) => boolean | void;
  readonly handleSignals?: boolean;
  readonly stdout?: 'inherit' | number;
}

/** The group's quiescence could not be established, so its ownership record must remain. */
export class OwnedProcessGroupUnverifiedError extends Error {}

async function ensureGroupGone(pid: number, startedAt: string, token: string): Promise<void> {
  const currentStart = processStartTime(pid);
  if (currentStart === startedAt) {
    try {
      if (!verifiedGate(pid, token)) throw new Error('The gate token or process group changed.');
      process.kill(-pid, 'SIGTERM');
      const grace = Date.now() + 2_000;
      while (Date.now() < grace) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw error;
        }
        await Bun.sleep(50);
      }
      if (processStartTime(pid) !== startedAt || !verifiedGate(pid, token))
        throw new Error('The gate identity is no longer verifiable.');
      process.kill(-pid, 'SIGKILL');
      const deadline = Date.now() + 58_000;
      while (Date.now() < deadline) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
          throw error;
        }
        await Bun.sleep(50);
      }
      throw new Error('The owned process group is still live.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new OwnedProcessGroupUnverifiedError('Could not retire the owned process group.', {
        cause: error,
      });
    }
  }
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  throw new OwnedProcessGroupUnverifiedError(
    `Owned process group ${pid} survived without a verifiable leader.`,
  );
}

/** Start a process group only after its identity is durably registered by its owner. */
export async function runOwnedProcessGroup(options: OwnedProcessGroupOptions): Promise<number> {
  const command = [...options.command];
  const environment = { ...options.environment };
  const { cwd, register, started, handleSignals, stdout } = options;
  const [program] = command;
  if (program === undefined) throw new Error('An owned process group needs a command.');
  const token = options.token ?? crypto.randomUUID();
  const child = spawn(
    process.execPath,
    ['--no-install', join(import.meta.dir, 'owned-process-gate.ts'), `--owned-token=${token}`],
    {
      cwd,
      env: environment,
      detached: true,
      stdio: ['pipe', stdout ?? 'inherit', 'inherit'],
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  const pid = child.pid;
  if (pid === undefined) {
    await exited;
    throw new Error('Could not start the owned process gate.');
  }
  const input = child.stdin;
  if (input === null) {
    child.kill('SIGTERM');
    await exited;
    throw new Error('The owned process gate has no input pipe.');
  }
  let pipeFailure: Error | undefined;
  input.on('error', (error) => {
    pipeFailure = error;
  });
  const startedAt = processStartTime(pid);
  if (startedAt === undefined) {
    input.destroy();
    await exited;
    throw new Error('Could not verify the owned process identity.');
  }
  let signalFailure: Error | undefined;
  const forward = (signal: NodeJS.Signals) => {
    if (processStartTime(pid) !== startedAt || !verifiedGate(pid, token)) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      }
      signalFailure = new Error(
        'The owned process identity could not be verified before signalling.',
      );
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const handlers = signals.map((signal) => () => forward(signal));
  if (handleSignals !== false) {
    for (const [index, signal] of signals.entries()) process.on(signal, handlers[index]!);
  }
  let result: number | undefined;
  let failure: unknown;
  let failed = false;
  try {
    await register(pid, startedAt);
    if (started?.(pid, forward) === false) input.destroy();
    else input.end(JSON.stringify({ command }));
    const outcome = await exited;
    if (pipeFailure !== undefined) throw pipeFailure;
    result =
      outcome.signal === null ? (outcome.code ?? 1) : 128 + constants.signals[outcome.signal];
  } catch (error) {
    failed = true;
    failure = error;
  }
  input.destroy();
  if (handleSignals !== false) {
    for (const [index, signal] of signals.entries()) process.off(signal, handlers[index]!);
  }
  try {
    if (signalFailure !== undefined)
      throw new OwnedProcessGroupUnverifiedError(signalFailure.message, { cause: signalFailure });
    await ensureGroupGone(pid, startedAt, token);
  } catch (error) {
    if (failed)
      throw new OwnedProcessGroupUnverifiedError(
        'The operation and its process cleanup both failed.',
        { cause: new AggregateError([failure, error]) },
      );
    throw error;
  }
  if (failed) throw failure;
  return result ?? 1;
}
