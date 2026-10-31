/**
 * The plugins a test supplied, as `bureau.plugins.list()` reports them: every Bureau also lists the
 * built-in `bureau` plugin first (COR-1890), which a test of its own plugins has no part in.
 */
import type { PluginListing } from '../plugins/plugin-types.ts';

/** `bureau.plugins.list()` without the built-in plugins, so a test's plugins keep their positions. */
export async function listedPlugins(bureau: {
  readonly plugins: { list(): Promise<readonly PluginListing[]> };
}): Promise<PluginListing[]> {
  const listed = await bureau.plugins.list();
  return listed.filter((listing) => listing.source !== 'built-in');
}
