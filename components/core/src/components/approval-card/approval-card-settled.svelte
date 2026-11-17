<script lang="ts">
  import type { Snippet } from 'svelte';

  import Button from '../button/button.svelte';

  /** Props of the internal settled card. Not part of the public API. */
  type ApprovalCardSettledProps = {
    /** Tag of the title heading. */
    titleTag: string;
    /** Id of the title heading, which names the article. */
    titleId: string;
    /** What the heading says: the question an approval asked, or the action a decision settled. */
    title: string;
    /** What assistive technology hears before the title, so the heading keeps the state in its name. */
    stateName: string;
    /** The one status line: why the card is read-only, or what was decided and by whom. */
    status: Snippet;
    /**
     * Green for an approval, neutral for a denial: the dot before the status line's first word.
     * Without it the line has no dot, as an expired card's has none.
     */
    tone?: 'success' | 'neutral' | undefined;
    /** Requests a fresh approval, or `undefined` when the host cannot. */
    onAskAgain?: (() => void) | undefined;
    /** Extra classes for the heading, so each layout keeps its own title hooks. */
    titleClass?: string | undefined;
  };

  let {
    titleTag,
    titleId,
    title,
    stateName,
    status,
    tone,
    onAskAgain,
    titleClass,
  }: ApprovalCardSettledProps = $props();
</script>

<!-- A settled approval is one pattern in three states: the title, one small muted status line, and
     at the trailing end of that line Ask again where the host can ask again. When it settled is the
     host's to say, under the card, in the same line as any message's time. The heading keeps the
     state in its accessible name. Only the status words and the dot's tone differ between states. -->
<div class="cinder-approval-card__settled-row" data-cinder-tone={tone}>
  <svelte:element
    this={titleTag}
    id={titleId}
    class={`cinder-approval-card__settled-title ${titleClass ?? ''}`.trim()}
    dir="auto"
  >
    <span class="cinder-sr-only">{stateName}:</span>{' '}{title}
  </svelte:element>
  <p class="cinder-approval-card__settled-note">
    {#if tone !== undefined}<span class="cinder-approval-card__settled-dot" aria-hidden="true"
      ></span>{/if}{@render status()}
  </p>
  {#if onAskAgain !== undefined}
    <div class="cinder-approval-card__settled-actions">
      <Button type="button" variant="secondary" size="sm" onclick={onAskAgain}>Ask again</Button>
    </div>
  {/if}
</div>
