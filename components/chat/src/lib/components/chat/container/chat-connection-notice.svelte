<script lang="ts" module>
  import type { ChatTurnLabels } from '../message/turn-labels.ts';
  import type { ChatTurnState } from '../message/turn-state.ts';

  export type ChatConnectionNoticeProps = {
    /** The reconnecting state of the turn whose stream dropped. */
    turn: Extract<ChatTurnState, { kind: 'reconnecting' }>;
    /** Host replacements for the notice's words. */
    turnLabels?: Partial<ChatTurnLabels> | undefined;
    /** Called when the person chooses Retry. Retry shows only when this is set. */
    onRetry?: (() => void) | undefined;
    /** The retry the person chose is under way: Retry reads busy and ignores presses. */
    busy?: boolean | undefined;
  };
</script>

<script lang="ts">
  import { Callout, Progress, WifiOff } from '@lostgradient/cinder';

  import { formatCountdown } from '../../../utilities/format-countdown.ts';
  import RetryButton from '../message/retry-button.svelte';
  import { resolveTurnLabels } from '../message/turn-labels.ts';
  import { reconnectWaitFraction } from '../message/turn-state.ts';

  let { turn, turnLabels, onRetry, busy = false }: ChatConnectionNoticeProps = $props();

  const words = $derived(resolveTurnLabels(turnLabels));
</script>

{#snippet retryAction()}
  <RetryButton
    class="chat-turn-action"
    label={words.retryNow}
    loading={busy}
    onclick={() => onRetry?.()}
  />
{/snippet}

<!-- The dropped stream is about the connection, so its notice stands beside the composer, in the
     slot the offline and restored-draft notices use, and not under the partial reply. -->
<div class="chat-connection-notice" data-kind="reconnecting">
  <Callout
    variant="warning"
    semantic="note"
    class="chat-connection-callout"
    {...onRetry ? { action: retryAction } : {}}
  >
    {#snippet icon()}<WifiOff aria-hidden="true" />{/snippet}
    <p class="chat-connection-text" dir="auto">
      {words.reconnecting(turn.attempt, turn.attempts, turn.nextTryIn)}
    </p>
    {#snippet progress()}
      <Progress
        class="chat-connection-wait"
        value={Math.round(reconnectWaitFraction(turn) * 100)}
        max={100}
        size="sm"
        ariaLabel={words.nextTry}
        label={formatCountdown(turn.nextTryIn)}
      />
    {/snippet}
  </Callout>
</div>

<style>
  .chat-connection-notice {
    inline-size: 100%;
    min-inline-size: 0;
    font-size: var(--cinder-text-sm);
    text-align: start;
  }

  .chat-connection-text {
    display: block;
    min-inline-size: 0;
    margin: 0;
    overflow-wrap: anywhere;
    text-align: start;
  }

  .chat-connection-notice :global(.chat-turn-action) {
    inline-size: auto;
    min-inline-size: 0;
    max-inline-size: none;
    padding-inline: var(--cinder-space-3);
  }
</style>
