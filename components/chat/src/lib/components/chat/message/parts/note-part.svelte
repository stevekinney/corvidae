<script lang="ts">
  import type { Snippet } from 'svelte';
  import { CircleAlert, Info } from '@lostgradient/cinder';

  import type { ChildRunStatus, MessageNoteInfo } from '../../utilities/types.ts';

  /**
   * One line a run left under a message: what it remembered, when it continues, a child run, why it
   * stopped. A run that failed reads as a status line in danger text with an error glyph, not as the
   * agent's own words; a notice (`notice: true`, a chat that ended because the server restarted)
   * reads as a muted status line with an info glyph and no "Stopped" label; `action` draws at its
   * end, for a Retry the host can act on.
   */
  let {
    note,
    action,
  }: { note: MessageNoteInfo; action?: Snippet<[note: MessageNoteInfo]> | undefined } = $props();

  const childRunLabels: Record<ChildRunStatus, string> = {
    running: 'Running',
    completed: 'Finished',
    failed: 'Failed',
    aborted: 'Stopped',
  };

  /** A stand-in origin to resolve a link against; any origin the link leaves is not the host's. */
  const HOST_ORIGIN = 'https://host.invalid';

  /**
   * A link inside the host application only. The link is resolved the way a browser resolves it, so
   * `/\evil.example` and a tab inside `//` (both read as a protocol-relative URL) leave the origin
   * and are dropped, where a test of the first characters passes them. The resolved path is what
   * is rendered, so the link followed is the link checked.
   */
  function safeHref(href: string | undefined): string | undefined {
    if (href === undefined || !href.startsWith('/')) return undefined;
    try {
      const resolved = new URL(href, HOST_ORIGIN);
      return resolved.origin === HOST_ORIGIN
        ? `${resolved.pathname}${resolved.search}${resolved.hash}`
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** The time of day for today and the date with it for any other day. */
  function wakeText(wakeAt: number): string {
    const when = new Date(wakeAt);
    const today = new Date();
    const sameDay =
      when.getFullYear() === today.getFullYear() &&
      when.getMonth() === today.getMonth() &&
      when.getDate() === today.getDate();
    return when.toLocaleString(
      undefined,
      sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
    );
  }

  const href = $derived(
    note.kind === 'memory' || note.kind === 'child-run' ? safeHref(note.href) : undefined,
  );
</script>

{#if note.kind === 'child-run'}
  <div class="chat-note chat-note--card" data-kind="child-run" data-status={note.status}>
    <span class="chat-note__label">{note.agentName}</span>
    <span class="chat-note__status">{childRunLabels[note.status]}</span>
    {#if href !== undefined}
      <a class="chat-note__link" {href} data-chat-note-link>View run</a>
    {/if}
  </div>
{:else}
  <div
    class="chat-note"
    data-kind={note.kind}
    data-failed={note.kind === 'stopped' && note.failed === true ? '' : undefined}
    data-notice={note.kind === 'stopped' && note.failed !== true && note.notice === true
      ? ''
      : undefined}
  >
    {#if note.kind === 'memory'}
      <span class="chat-note__label">Remembered</span>
      <span class="chat-note__collection">{note.collection}</span>
      <span class="chat-note__memory-class">{note.memoryClass}</span>
      {#if href !== undefined}
        <a class="chat-note__link" {href} data-chat-note-link>View</a>
      {/if}
    {:else if note.kind === 'wakeup'}
      <span class="chat-note__label">Will continue at</span>
      <time datetime={new Date(note.wakeAt).toISOString()}>{wakeText(note.wakeAt)}</time>
      {#if note.note !== undefined && note.note !== ''}
        <span class="chat-note__detail">{note.note}</span>
      {/if}
    {:else if note.failed === true}
      <CircleAlert class="chat-note__glyph" aria-hidden="true" />
      <span class="chat-note__reason" role="status">{note.reason}</span>
    {:else if note.notice === true}
      <Info class="chat-note__glyph" aria-hidden="true" />
      <span class="chat-note__reason" role="status">{note.reason}</span>
    {:else}
      <span class="chat-note__label">Stopped</span>
      <span>{note.reason}</span>
    {/if}
    {#if action}
      <span class="chat-note__action">{@render action(note)}</span>
    {/if}
  </div>
{/if}

<style>
  .chat-note {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    overflow-wrap: anywhere;
  }

  .chat-note--card {
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }

  /* A failed run, or a notice: one line that wraps beside its action, nothing filled. */
  .chat-note[data-kind='stopped'][data-failed],
  .chat-note[data-kind='stopped'][data-notice] {
    flex-wrap: nowrap;
    align-items: flex-start;
  }

  .chat-note[data-kind='stopped'][data-failed] {
    color: var(--cinder-status-danger-text);
  }

  .chat-note[data-kind='stopped'][data-failed] .chat-note__reason,
  .chat-note[data-kind='stopped'][data-notice] .chat-note__reason {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  :global(.chat-note__glyph) {
    flex: none;
    inline-size: 1rem;
    block-size: 1rem;
    margin-block-start: 0.125rem;
  }

  .chat-note__action {
    flex: none;
    margin-inline-start: auto;
  }

  .chat-note__label {
    flex: none;
    font-weight: var(--cinder-font-medium);
    color: var(--cinder-text-default);
  }

  .chat-note__link {
    color: inherit;
    text-decoration: underline;
  }
</style>
