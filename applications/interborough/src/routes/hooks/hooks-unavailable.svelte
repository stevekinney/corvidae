<script lang="ts">
  /**
   * What a home that keeps hooks off says in place of the hooks pages. The Bureau answers that it has
   * no hooks, and there is nothing the person can do here to change it, so the state has no action.
   */
  import { EmptyState } from '@lostgradient/cinder';

  import { HOOKS_COPY } from './hook-copy.ts';
</script>

<EmptyState
  kind="first-use"
  title={HOOKS_COPY.unavailable.title}
  description={HOOKS_COPY.unavailable.description}
  headingLevel={1}
  data-testid="hooks-unavailable"
/>
