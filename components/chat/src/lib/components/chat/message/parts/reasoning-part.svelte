<script lang="ts" module>
  import type { ReasoningMessagePart } from '../../utilities/types.ts';

  export type ReasoningPartProps = {
    /** The reasoning render part to display. */
    part: ReasoningMessagePart;
    /** Whether this reasoning block is expanded. Controlled by the parent (use-chat-disclosure-state). */
    expanded?: boolean;
    /** Called when the disclosure toggle is activated. */
    onToggle?: (() => void) | undefined;
  };
</script>

<script lang="ts">
  import EntryFrame from '../entry-frame.svelte';

  let { part, expanded = false, onToggle }: ReasoningPartProps = $props();

  const labelId = $derived(`reasoning-label-${part.key.replace(/[^a-z0-9-]/gi, '-')}`);
  const contentId = $derived(`reasoning-content-${part.key.replace(/[^a-z0-9-]/gi, '-')}`);

  // The label is in the person's terms, never tokens (C#10): "Thinking…" with the seconds so far
  // while the reasoning streams, then "Thought for 4 s" once it ends. A block that never streamed
  // here has no time this page saw, and reads "Thought process".
  let streamStartedAt = $state<number | undefined>(undefined);
  let thoughtMilliseconds = $state<number | undefined>(undefined);
  let clock = $state(Date.now());
  $effect(() => {
    if (!part.streaming) return;
    const start = Date.now();
    streamStartedAt = start;
    clock = start;
    const timer = setInterval(() => {
      clock = Date.now();
    }, 1000);
    return () => {
      clearInterval(timer);
      thoughtMilliseconds = Date.now() - start;
    };
  });
  const elapsedSeconds = $derived(
    streamStartedAt === undefined ? 0 : Math.max(0, Math.floor((clock - streamStartedAt) / 1000)),
  );
  const label = $derived(
    part.streaming
      ? 'Thinking…'
      : thoughtMilliseconds === undefined
        ? 'Thought process'
        : `Thought for ${Math.max(1, Math.round(thoughtMilliseconds / 1000))} s`,
  );

  // The polite "Reasoning complete." announcement fires ONLY on a streaming
  // true→false transition — not on a reasoning block that was never streaming
  // (a static historical block must stay silent). We observe the transition edge
  // here: this effect's sole job is to record that a stream just ended, which is
  // observing an external lifecycle ("a stream finished"), not deriving state
  // from state. `announced` flips to true on the edge and back to false when a
  // new stream starts, so the live region fires once per streaming session.
  let wasStreaming = false;
  let announced = $state(false);
  $effect(() => {
    const streaming = part.streaming;
    if (streaming) {
      announced = false;
    } else if (wasStreaming) {
      announced = true;
    }
    wasStreaming = streaming;
  });
  const announcementText = $derived(announced ? 'Reasoning complete.' : '');

  function handleToggle(): void {
    if (!part.streaming) {
      onToggle?.();
    }
  }
</script>

<!--
  Reasoning disclosure. Collapsed by default; the toggle button is disabled
  while streaming to prevent mid-stream layout jank. The expanded region uses
  aria-live="off" during streaming (token-by-token updates must not interrupt
  the screen reader) — one polite "Reasoning complete." fires when streaming ends.
  The grid-template-rows 0fr→1fr transition avoids max-height clamping artifacts.
-->
<div
  class="chat-reasoning"
  data-cinder-reasoning
  data-cinder-streaming={part.streaming ? '' : undefined}
  data-cinder-expanded={expanded ? '' : undefined}
>
  <EntryFrame
    id={labelId}
    {label}
    labelClass="chat-reasoning-label"
    status={part.streaming ? `${elapsedSeconds} s` : undefined}
    triggerClass="chat-reasoning-toggle"
    busy={part.streaming}
    open={expanded}
    disabled={part.streaming}
    onToggle={() => handleToggle()}
  >
    <div
      id={contentId}
      class="chat-reasoning-content"
      aria-live={part.streaming ? 'off' : undefined}
      aria-busy={part.streaming ? true : undefined}
    >
      {#if part.summary && part.summary.length > 0}
        <ul class="chat-reasoning-summary" aria-label="Reasoning summary">
          {#each part.summary as item}
            <li>{item}</li>
          {/each}
        </ul>
      {/if}
      {part.content}
    </div>
  </EntryFrame>

  <!-- Always-present polite live region. Fires "Reasoning complete." once when
       streaming ends (part.streaming: true→false). Clearing on resume ensures it
       fires again on subsequent streams. The element must be in the DOM before
       content is set so screen readers have already registered it as a live region. -->
  <div class="cinder-sr-only" aria-live="polite" aria-atomic="true">{announcementText}</div>
</div>

<style>
  .chat-reasoning {
    --cinder-chat-reasoning-bg: var(--cinder-surface-inset);
    --cinder-chat-reasoning-border: var(--cinder-border);
    --cinder-chat-reasoning-text: var(--cinder-text-muted);

    display: block;
  }

  /* Reasoning is a quiet disclosure inside the transcript, not a second card or select-like
   * control. EntryFrame still supplies the shared disclosure semantics and focus treatment. */
  .chat-reasoning :global(.chat-entry-frame) {
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .chat-reasoning :global(.chat-entry-frame__trigger) {
    min-block-size: 2rem;
    padding-block: var(--cinder-space-1);
    padding-inline: 0;
  }

  .chat-reasoning :global(.chat-entry-frame__panel-inner) {
    padding-inline: 0;
    border-block-start: 0;
  }

  .chat-reasoning-content {
    /* Hidden + non-focusable while collapsed. A scrollable region with
       overflow-y:auto is keyboard-focusable in some browsers even at zero
       height; visibility:hidden removes it from the tab order (and from AT),
       complementing aria-hidden. The parent grid (0fr) clips it visually. */
    padding: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    color: var(--cinder-chat-reasoning-text);
    line-height: var(--cinder-leading-relaxed, 1.625);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .chat-reasoning-summary {
    margin: 0 0 var(--cinder-space-2);
    padding-inline-start: var(--cinder-space-5);
  }

  /* Forced-colors: the decorative pulse dot and the accent rail use background/
     border colors the system overrides, so pin them to a system color. The
     box-shadow focus ring also disappears, so fall back to a system outline. */
  @media (forced-colors: active) {
    .chat-reasoning {
      border-inline-start-color: ButtonText;
    }
  }
</style>
