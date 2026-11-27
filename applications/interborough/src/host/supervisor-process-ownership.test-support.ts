/**
 * A stand-in host for `supervisor-process-ownership.integration.test.ts`: it publishes its own pid to
 * the file `OWNERSHIP_READY` names once it runs, then waits for a stop signal.
 */
import { renameSync, writeFileSync } from 'node:fs';

import { processEnvironment } from './environment-configuration.ts';

/** Names the file the stand-in host writes its pid to once it runs. */
export const OWNERSHIP_READY_VARIABLE = 'OWNERSHIP_READY';

if (import.meta.main) {
  const ready = processEnvironment()[OWNERSHIP_READY_VARIABLE];
  if (ready === undefined) throw new Error('The stand-in host needs a ready file.');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
  writeFileSync(`${ready}.partial`, String(process.pid));
  renameSync(`${ready}.partial`, ready);
  setInterval(() => {}, 1000);
}
