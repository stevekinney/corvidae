<script lang="ts" module>
  import type {
    IntersectionCallback,
    UseIntersectionOptions,
  } from '@lostgradient/foundation/utilities/use-intersection.types.ts';

  export type UseIntersectionAttachFixtureProps = {
    onIntersect: IntersectionCallback;
    options?: UseIntersectionOptions;
  };
</script>

<script lang="ts">
  import { useIntersection } from '@lostgradient/foundation/utilities/use-intersection.svelte.ts';

  let { onIntersect, options }: UseIntersectionAttachFixtureProps = $props();
</script>

<div data-testid="sentinel" {@attach useIntersection(onIntersect, options)}></div>
