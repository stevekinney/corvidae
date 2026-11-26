import * as backchannelArmorer from './index.ts';

/** Loads the Backchannel Armorer bridge through its public root. */
export function runRuntimeSmoke(): void {
  if (Object.keys(backchannelArmorer).length === 0)
    throw new Error('Backchannel Armorer has no root exports.');
}
