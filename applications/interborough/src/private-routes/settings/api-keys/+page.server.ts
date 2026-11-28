import type { ServerLoadEvent } from '@lostgradient/velveteen/server';
import { readSettingsAccess } from '../../../routes/settings/section-access.ts';

export async function load(event: ServerLoadEvent) {
  return {
    keyAccess: await readSettingsAccess('/host/api-keys/access', event.fetch, event.signal),
  };
}
