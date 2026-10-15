/**
 * Props a test can change after mounting. Svelte tracks property reads on a `$state` proxy, so
 * assigning to the returned object updates the mounted component the same way a parent's state
 * would. Only a `.svelte.ts` module can create the proxy.
 */
export function reactiveProps<Props extends Record<string, unknown>>(initial: Props): Props {
  const props = $state(initial);
  return props;
}
