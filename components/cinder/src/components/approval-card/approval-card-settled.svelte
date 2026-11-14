<script lang="ts">
  import Button from '../button/button.svelte';

  /** Props of the internal expired card. Not part of the public API. */
  type ApprovalCardExpiredProps = {
    /** Tag of the question heading. */
    titleTag: string;
    /** Id of the question heading, which names the article. */
    titleId: string;
    /** The question the approval asked. */
    question: string;
    /** Requests a fresh approval, or `undefined` when the host cannot. */
    onAskAgain: (() => void) | undefined;
    /** Extra classes for the heading, so each layout keeps its own title hooks. */
    titleClass?: string | undefined;
  };

  let { titleTag, titleId, question, onAskAgain, titleClass }: ApprovalCardExpiredProps = $props();
</script>

<!-- An expired approval is the question as the title, one small line saying why it is read-only,
     and Ask again at the trailing end. When it lapsed is the host's to say, under the card, in the
     same line as any message's time. The heading keeps the state in its accessible name. -->
<div class="cinder-approval-card__expired-row">
  <svelte:element
    this={titleTag}
    id={titleId}
    class={`cinder-approval-card__expired-title ${titleClass ?? ''}`.trim()}
    dir="auto"
  >
    <span class="cinder-sr-only">Expired before a decision:</span>{' '}{question}
  </svelte:element>
  <p class="cinder-approval-card__expired-note">Expired before a decision</p>
  {#if onAskAgain !== undefined}
    <div class="cinder-approval-card__expiry-actions">
      <Button type="button" variant="secondary" size="sm" onclick={onAskAgain}>Ask again</Button>
    </div>
  {/if}
</div>
