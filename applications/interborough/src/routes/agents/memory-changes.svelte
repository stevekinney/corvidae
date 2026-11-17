<script lang="ts" module>
  import type { ForgetResult } from '../../lib/memory-client.ts';

  /** What forgetting one memory answered: which memory, and the Bureau's deletion receipt. */
  export type ForgetOutcome = { readonly id: string; readonly result: ForgetResult };
</script>

<script lang="ts">
  /**
   * Forgetting a memory, for the whole Memory page. The details panel starts it (`askToForget`),
   * so the toast, the server's refusals, and the deletion's receipt exist once.
   *
   * The trash button forgets at once, with no question (row 45r): the memory leaves the list, and a
   * toast reads Forgot "…" with an Undo that stays until it is pressed or the page is left. The
   * Bureau has no way to bring a forgotten memory back, so nothing is sent while the toast shows:
   * the forget is sent when the toast closes (`onClose`), however it closes (the page left, a newer
   * toast pushing it out, a second forget taking its place), and Undo sends nothing and puts the
   * memory back. A forget that was sent reports what the deletion came to in the words for its
   * state (`MEMORY_COPY.forget.outcome`); once the page is gone, a forget that did not complete
   * says so in a toast instead. Correcting is the details panel's own form (`memory-detail.svelte`),
   * and sharing, holding, quarantining and exporting are `memory-governance.svelte`. Each change
   * names the memory it is for when it is asked, so a second request never changes what the first
   * one reports.
   */
  import { Alert } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import type { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import { MEMORY_COPY } from '../../app/copy/memory.ts';
  import { dismissToast, hasToastHost, showToast } from '../../app/toast-host.svelte';
  import {
    forgetMemory,
    memoryFaultOf,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter, queryKeys } from '../../lib/query.ts';
  import { excerpt, labelFor, refusalWords } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What the last forget answered, for the page to say when its memory stays stored. */
    outcome?: ForgetOutcome | undefined;
    /**
     * What is known of each memory's legal hold. A forget answered `exempt` records a hold here,
     * and unlike the receipt, which a person can dismiss, a hold the server confirmed stays known.
     */
    holds: SvelteMap<string, 'held' | 'free'>;
    /**
     * The memories the page leaves out of its list: one forgotten while its Undo shows, and one
     * whose forget is being saved. Undo, and a forget that did not complete, put it back.
     */
    hidden: SvelteSet<string>;
    /** True while a forget is being saved, for the page to hold every Forget until it settles. */
    forgetPending?: boolean;
    /** Called once a memory leaves the list, so the page can open the next one in its place. */
    onForgotten: (id: string) => void;
  };

  let {
    agentId,
    outcome = $bindable(),
    holds,
    hidden,
    forgetPending = $bindable(false),
    onForgotten,
  }: Props = $props();

  const queryClient = useQueryClient();
  const toasts = hasToastHost();

  let failure = $state<MemoryFault | undefined>(undefined);

  /** A memory forgotten on the page whose forget waits for its toast to close. */
  type Waiting = {
    readonly id: string;
    toast: string | undefined;
    /** Undo was pressed: nothing is sent. */
    undone: boolean;
    /** The forget was sent: nothing is sent again. */
    sent: boolean;
  };
  let waiting: Waiting | undefined;
  let destroyed = false;

  /** What a forget answered: the receipt above the list, and the memory back when it stays. */
  function settled(id: string, result: Awaited<ReturnType<typeof forgetMemory>>): void {
    if (result.deletion === 'exempt') holds.set(id, 'held');
    if (result.deletion !== 'completed') hidden.delete(id);
    // A memory that is gone has no details to read again: the outcome stays on screen.
    void queryClient.invalidateQueries(
      result.deletion === 'completed'
        ? memoryListingsFilter(agentId)
        : { queryKey: queryKeys.memory.all(agentId) },
    );
  }

  const forget = createMutation(() => ({
    mutationFn: (id: string) => forgetMemory(agentId, id),
    onMutate: () => {
      failure = undefined;
      outcome = undefined;
    },
    onSuccess: (result, id) => {
      outcome = { id, result };
      settled(id, result);
    },
    onError: (error, id) => {
      hidden.delete(id);
      failure = memoryFaultOf(error);
    },
  }));

  $effect(() => {
    forgetPending = forget.isPending;
  });

  /**
   * Sends the forget of `entry`, once, unless Undo was pressed. On the page the receipt says what
   * it came to; once the page is gone, only a forget that did not complete says so, in a toast.
   */
  function send(entry: Waiting): void {
    if (entry.undone || entry.sent) return;
    entry.sent = true;
    if (waiting === entry) waiting = undefined;
    if (!destroyed) {
      forget.mutate(entry.id);
      return;
    }
    void sendAfterLeaving(entry.id);
  }

  /** The forget the page held back, sent once it is gone: only one that did not complete says so. */
  async function sendAfterLeaving(id: string): Promise<void> {
    try {
      const result = await forgetMemory(agentId, id);
      settled(id, result);
      if (result.deletion !== 'completed' && toasts) {
        showToast(MEMORY_COPY.forget.outcome[result.deletion].title, { variant: 'warning' });
      }
    } catch {
      if (toasts) showToast(MEMORY_COPY.forget.failed, { variant: 'danger' });
    }
  }

  /**
   * Forgets `memory` at once, with no question (row 45r): it leaves the list, and a toast with Undo
   * says so. The forget is sent when the toast closes. A second forget sends the first one's now,
   * so only the newest has an Undo. Nothing happens while a forget is being saved.
   */
  export function askToForget(memory: Pick<Memory, 'id' | 'content'>): void {
    if (forget.isPending || waiting?.id === memory.id) return;
    const before = waiting;
    if (before !== undefined) {
      if (before.toast !== undefined) dismissToast(before.toast);
      send(before);
    }
    const entry: Waiting = { id: memory.id, toast: undefined, undone: false, sent: false };
    waiting = entry;
    // The page opens the next memory while this one is still in its list, then it leaves.
    onForgotten(memory.id);
    hidden.add(memory.id);
    if (!toasts) {
      // With nowhere to offer Undo, the forget is sent at once.
      send(entry);
      return;
    }
    entry.toast = showToast(MEMORY_COPY.forget.toast(excerpt(memory.content)), {
      variant: 'success',
      undo: () => {
        entry.undone = true;
        if (waiting === entry) waiting = undefined;
        hidden.delete(entry.id);
      },
      onClose: () => send(entry),
    });
  }

  // Closing the tab or the window takes the toast with it, and no component is destroyed then: the
  // forget is sent as the page goes, kept alive past the page's end.
  $effect(() => {
    const pageHidden = (): void => {
      const entry = waiting;
      if (entry === undefined || entry.undone || entry.sent) return;
      entry.sent = true;
      waiting = undefined;
      void forgetMemory(agentId, entry.id, {
        fetch: (input, init) => fetch(input, { ...init, keepalive: true }),
      }).catch(() => undefined);
    };
    window.addEventListener('pagehide', pageHidden);
    return () => window.removeEventListener('pagehide', pageHidden);
  });

  // Leaving the page closes the toast, and the forget it held back is sent.
  onDestroy(() => {
    destroyed = true;
    const entry = waiting;
    if (entry === undefined) return;
    if (entry.toast !== undefined) dismissToast(entry.toast);
    send(entry);
  });

  const outcomeWords = $derived(
    outcome === undefined ? undefined : MEMORY_COPY.forget.outcome[outcome.result.deletion],
  );
</script>

{#if outcomeWords !== undefined && outcome !== undefined}
  <Alert
    variant={outcome.result.deletion === 'completed' ? 'success' : 'warning'}
    dismissible
    onDismiss={() => (outcome = undefined)}
  >
    <p class="weft-memory-changes__alert-title" data-forget-outcome={outcome.result.deletion}>
      {outcomeWords.title}
    </p>
    <p class="weft-memory-changes__alert-body">{outcomeWords.description}</p>
    <p class="weft-memory-changes__alert-body">{MEMORY_COPY.forget.receiptLabel}</p>
    <ul class="weft-memory-changes__targets">
      {#each outcome.result.receipt.targets as target (target.target)}
        <li data-target={target.target} data-status={target.status}>
          {labelFor(MEMORY_COPY.forget.targets, target.target)}:
          {MEMORY_COPY.forget.targetStatus[target.status]}
        </li>
      {/each}
    </ul>
  </Alert>
{/if}

{#if failure !== undefined}
  {@const words = refusalWords(failure)}
  <Alert variant="danger" dismissible onDismiss={() => (failure = undefined)}>
    <p class="weft-memory-changes__alert-title">{MEMORY_COPY.forget.failed}</p>
    <p class="weft-memory-changes__alert-body">{words.description || words.title}</p>
  </Alert>
{/if}

<style>
  .weft-memory-changes__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-memory-changes__alert-body {
    margin: var(--cinder-space-1) 0;
  }

  .weft-memory-changes__targets {
    margin: 0;
    padding-inline-start: var(--cinder-space-5);
  }
</style>
