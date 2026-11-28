<script lang="ts">
  /**
   * The forbidden page uses the shared state layout with a lock and a link back to Home.
   */
  import { Button, EmptyState } from '@lostgradient/cinder';
  import { Lock } from '@lucide/svelte';

  import { router } from '../lib/router.svelte.ts';
  import { FORBIDDEN_COPY } from './copy/views.ts';

  interface ForbiddenStateProps {
    /** Names what is locked: "Your sign-in can’t open Hooks". */
    title: string;
    headingLevel?: 1 | 2;
  }

  let { title, headingLevel = 1 }: ForbiddenStateProps = $props();
</script>

<EmptyState kind="disabled" {headingLevel} {title} description={FORBIDDEN_COPY.description}>
  {#snippet icon()}<Lock aria-hidden="true" />{/snippet}
  {#snippet action()}
    <Button variant="secondary" href={router.href('/')}>
      {FORBIDDEN_COPY.home}
    </Button>
  {/snippet}
</EmptyState>
