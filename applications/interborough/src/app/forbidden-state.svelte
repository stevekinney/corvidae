<script lang="ts">
  /**
   * The forbidden page (design rows 12z and 13a): Cinder's access gate as a whole page, with a
   * neutral disc and lock glyph, a title that names what is locked ("Your sign-in can’t open
   * Hooks"), the sentence that points at where the session's scopes are shown, and the missing
   * scope small and monospaced ("requires hooks:read") when it is known. It has two secondary
   * buttons, "See your scopes" and "Back to Home", and no request-access button: single-user v1
   * has no such flow.
   */
  import { AccessGate, Button } from '@lostgradient/cinder';

  import { router } from '../lib/router.svelte.ts';
  import { FORBIDDEN_COPY } from './copy.ts';

  interface ForbiddenStateProps {
    /** Names what is locked: "Your sign-in can’t open Hooks". */
    title: string;
    /** The scope that opens it, when it is known. Nothing is shown when it is not. */
    requirement?: string | undefined;
  }

  let { title, requirement }: ForbiddenStateProps = $props();

  // The scope is the person's to read, and Interborough never says "Bureau" to them: "goals:read".
  const shownRequirement = $derived(requirement?.replace(/^bureau\./, ''));

  /** A button opens its page without leaving the application. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<AccessGate
  granted={false}
  variant="section"
  layout="page"
  headingLevel={1}
  {title}
  reason={FORBIDDEN_COPY.description}
  {...shownRequirement === undefined ? {} : { requirement: shownRequirement }}
>
  {#snippet actions()}
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
</AccessGate>
