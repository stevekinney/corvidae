<script lang="ts">
  /**
   * The confirmation after a restart: a success banner that says Interborough is back and what
   * applied, with Dismiss. The words are the caller's (`restart-back-copy.ts` writes them for the
   * restart's intent), so every page that restarts the host says it the same way.
   */
  import { Banner, Button } from '@lostgradient/cinder';

  import { RESTART_COPY } from '../copy.ts';

  interface Props {
    /** The lead, such as "Back up" or "Back up. Web search is disabled." */
    title: string;
    /** What applied and what it affects. */
    text: string;
    /** Called when the person dismisses the banner. */
    onDismiss: () => void;
  }

  let { title, text, onDismiss }: Props = $props();
</script>

<Banner
  variant="success"
  dismissible={false}
  {title}
  aria-label={RESTART_COPY.back.title}
  data-testid="restart-back"
>
  <span data-testid="restart-back-text">{text}</span>
  {#snippet actions()}
    <Button variant="secondary" size="sm" onclick={onDismiss}>{RESTART_COPY.back.dismiss}</Button>
  {/snippet}
</Banner>
