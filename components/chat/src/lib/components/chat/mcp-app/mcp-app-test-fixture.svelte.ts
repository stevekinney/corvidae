import type { McpAppProps } from './mcp-app.types.ts';

/**
 * A `$state` props object for `mount(McpApp, { props })`, so a test can change props in place;
 * Testing Library's `rerender` remounts the component under Svelte 5.
 */
export function createLiveProps(initial: McpAppProps): McpAppProps {
  const props = $state<McpAppProps>(initial);
  return props;
}
