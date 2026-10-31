/**
 * What a plugin's tests and the repository's plugin checks use: the conformance suite, and the
 * identity snapshot a plugin commits. Kept out of the package root so it is never loaded outside a
 * test runner.
 *
 * @module interborough-plugin/testing
 */
export {
  checkPluginContract,
  pluginContract,
  type CreatePluginTestHost,
  type PluginContractFailure,
  type PluginContractOptions,
  type PluginTestHost,
  type PluginTestHostAgent,
  type PluginTestHostListing,
} from './plugin-contract.ts';
export {
  canonicalJson,
  pluginContributions,
  pluginIdentities,
  schemaDigest,
  type PluginIdentities,
  type PluginIdentityEntry,
} from './plugin-identities.ts';
