import { type Storage, scopedStorage } from '@lostgradient/storage';

import { isPluginName } from './plugin-name.ts';

/**
 * The key prefix a plugin's storage is confined to: `plugin:<name>:`. A key a plugin writes as
 * `state` lands in the backing store as `plugin:<name>:state`.
 */
export function pluginStoragePrefix(pluginName: string): string {
  if (!isPluginName(pluginName)) {
    throw new TypeError(`Plugin name ${JSON.stringify(pluginName)} is not a valid plugin name.`);
  }
  return `plugin:${pluginName}:`;
}

/**
 * Scopes `storage` to the plugin's key prefix, so two plugins sharing one backing store never see
 * each other's keys. Rejects a name that is not a valid plugin name, because a name containing `:`
 * could otherwise reach into another plugin's prefix.
 */
export function createPluginStorage(storage: Storage, pluginName: string): Storage {
  // `scopedStorage` joins the prefix and the key with `:`, so it takes the prefix without one.
  return scopedStorage(storage, pluginStoragePrefix(pluginName).slice(0, -1));
}
