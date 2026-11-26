import { createManualRuntimeServices } from './index.ts';

/** Exercises the portable lifecycle root under a host runtime. */
export function runRuntimeSmoke(): void {
  const services = createManualRuntimeServices();
  services.clock.now();
}
