/**
 * The Bureau's hooks as this host turns them on (COR-1939, COR-1978).
 *
 * A home on the person's own machine takes Bureau's defaults: signing secrets sealed in its store,
 * and a receiver on the person's own network is allowed. A remote home supports hooks only with both
 * of what follows:
 *
 * - Its secrets live in the environment, not in its store, so {@link DEPLOYMENT_HOOK_SECRETS} refuses
 *   a secret write with the reason `deployment`. A webhook needs a secret, so a remote home cannot
 *   write one; a hook that starts a workflow, notifies, or runs a plugin's action holds none.
 * - Its private-network addresses are the deployment's and not the person's, so
 *   `allowPrivateNetworks` is off and no hook reaches them.
 */
import type { BureauHooksOptions, HookSecretStore } from '@lostgradient/bureau';

/** The secret port of a remote home: it holds nothing, and a write is refused with `deployment`. */
export const DEPLOYMENT_HOOK_SECRETS: HookSecretStore = {
  writeLock: () => 'deployment',
  get: () => Promise.resolve(undefined),
  // Bureau asks `writeLock` first, so nothing reaches this.
  set: () => Promise.reject(new Error('This home keeps its secrets in its environment')),
  delete: () => Promise.resolve(),
};

/** The `hooks` option of a Bureau on a home of `mode`. */
export function hookOptionsFor(mode: 'local' | 'remote'): BureauHooksOptions {
  return mode === 'remote'
    ? { secrets: DEPLOYMENT_HOOK_SECRETS, urlPolicy: { allowPrivateNetworks: false } }
    : {};
}
