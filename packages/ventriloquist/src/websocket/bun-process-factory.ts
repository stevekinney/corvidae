import { createPipeProcess } from '../bun/pipe-process.ts';
import type { HostedProcess, ProcessHostOptions } from '../bun/process-types.ts';
import { createPtyProcess } from '../bun/pty-process.ts';
import type { CreateProcess, LaunchSnapshot } from './websocket-types.ts';

/**
 * The default `createProcess`: a PTY or a pipe process from the Bun helpers, made from the launch
 * snapshot the host authorized. It is a separate module so that the server itself never names a
 * process API, and so a test of the server's handlers does not start a process.
 */
export function createBunProcessFactory(hostOptions: ProcessHostOptions = {}): CreateProcess {
  return (launch: LaunchSnapshot): HostedProcess =>
    launch.mode === 'pty'
      ? createPtyProcess({
          profile: launch.profile,
          dimensions: launch.dimensions,
          ...hostOptions,
        })
      : createPipeProcess({
          profile: launch.profile,
          acceptsInput: launch.acceptsInput === true,
          ...hostOptions,
        });
}
