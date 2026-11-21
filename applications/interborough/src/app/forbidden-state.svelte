<script lang="ts">
  /**
   * The forbidden page uses the shared state layout with a lock and a link to the session's scopes.
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

  /** A button opens its page without leaving the application. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<EmptyState kind="disabled" {headingLevel} {title} description={FORBIDDEN_COPY.description}>
  {#snippet icon()}<Lock aria-hidden="true" />{/snippet}
  {#snippet action()}
    <Button
      variant="secondary"
      href={router.href(FORBIDDEN_COPY.scopes.href)}
      onclick={(event) => open(event, FORBIDDEN_COPY.scopes.href)}
    >
      {FORBIDDEN_COPY.scopes.label}
    </Button>
    <Button variant="secondary" href={router.href('/')} onclick={(event) => open(event, '/')}>
      {FORBIDDEN_COPY.home}
    </Button>
  {/snippet}
</EmptyState>
