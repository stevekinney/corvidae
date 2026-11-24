/**
 * For the registry's tests: runs `release` from an effect's teardown, as a page's `onMount` cleanup
 * runs, where Svelte refuses to create an effect. Returns what destroys the effect.
 */
import { flushSync } from 'svelte';

export function releaseFromTeardown(release: () => void): () => void {
  const destroy = $effect.root(() => {
    $effect(() => () => release());
  });
  flushSync();
  return destroy;
}
