import { openBungalow } from '@lostgradient/bungalow';

/** Persist a fresh fixture home's identity before the fixture writes application state. */
export async function initializeWorkspaceHome(home: string): Promise<void> {
  using bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  bungalow.close();
}
