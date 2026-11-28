import type { ServerLoadEvent } from '@lostgradient/velveteen/server';
import { readSettingsAccess } from '../../../routes/settings/section-access.ts';

export async function load(event: ServerLoadEvent) {
  return {
    access: await readSettingsAccess('/host/connected-apps/access', event.fetch, event.signal),
  };
}
