<script lang="ts">
  /**
   * What an operator does to a memory beyond reading, correcting and forgetting it, for the whole
   * Memory page: share it with another owner (and stop), place or release a legal hold, quarantine
   * it, and export every memory of the agent. The details panel starts the first four
   * (`askToShare`, `changeHold`, `askToQuarantine`) and the list's Export starts the last
   * (`exportAll`), so each question, refusal and result exists once.
   *
   * Each change goes through the memory API (`lib/memory-client.ts`), never raw storage, and the
   * server records it in the memory ledger under the caller's owner. This page says so after each.
   * A legal hold has no read of its own, so the hold state this page knows comes from here: a
   * hold or a release, in `holds`, shared with `memory-changes.svelte`, which records one a forget
   * ran into. Quarantine asks first, names the memory that goes, and says it cannot be undone.
   */
  import { Alert, Button, Input, Modal, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import type { SvelteMap } from 'svelte/reactivity';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import {
    changeLegalHold,
    changeMemoryShare,
    exportMemories,
    memoryFaultOf,
    quarantineMemory,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter, queryKeys } from '../../lib/query.ts';
  import { downloadJson } from '../workflows/detail/export-events.ts';
  import { excerpt, refusalWords } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What is known of each memory's legal hold: placed or released here, or met by a forget. */
    holds: SvelteMap<string, 'held' | 'free'>;
    /** True while a governance change is being saved, for the page to hold the others until it settles. */
    pending?: boolean;
    /** Called once a memory is quarantined, so the page can close its details. */
    onQuarantined: (id: string) => void;
  };

  let { agentId, holds, pending = $bindable(false), onQuarantined }: Props = $props();

  const words = MEMORY_COPY.govern;
  const queryClient = useQueryClient();

  /** What the last change came to, in the words for it. */
  type Notice =
    | { readonly kind: 'done'; readonly title: string; readonly description: string }
    | { readonly kind: 'failed'; readonly fault: MemoryFault };

  let notice = $state<Notice | undefined>(undefined);
  let sharing = $state<Pick<Memory, 'id' | 'content'> | undefined>(undefined);
  let shareOpen = $state(false);
  let grantee = $state('');
  let quarantining = $state<Pick<Memory, 'id' | 'content'> | undefined>(undefined);
  let quarantineOpen = $state(false);
  let reason = $state('');

  function done(title: string, description: string): void {
    notice = { kind: 'done', title, description: `${description} ${words.recorded}` };
  }

  function failed(error: unknown): void {
    notice = { kind: 'failed', fault: memoryFaultOf(error) };
  }

  const share = createMutation(() => ({
    mutationFn: (change: {
      readonly id: string;
      readonly owner: string;
      readonly change: 'granted' | 'revoked';
    }) => changeMemoryShare(agentId, change.id, change.owner, change.change),
    onSuccess: (result, change) => {
      shareOpen = false;
      const outcome = words.share.outcome;
      const text =
        change.change === 'granted'
          ? result.changed
            ? outcome.granted
            : outcome.alreadyGranted
          : result.changed
            ? outcome.revoked
            : outcome.notShared;
      done(text.title, text.description(result.granteeOwnerId));
    },
    onError: failed,
  }));

  const hold = createMutation(() => ({
    mutationFn: (change: { readonly id: string; readonly change: 'place' | 'release' }) =>
      changeLegalHold(agentId, change.id, change.change),
    onSuccess: (result) => {
      holds.set(result.id, result.legalHold === 'held' ? 'held' : 'free');
      const outcome = words.hold.outcome;
      const text =
        result.legalHold === 'held'
          ? result.changed
            ? outcome.placed
            : outcome.alreadyPlaced
          : result.changed
            ? outcome.released
            : outcome.notHeld;
      done(text.title, text.description);
      // A release lets a deletion that was waiting on the hold go ahead: read the lists again.
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.all(agentId) });
    },
    onError: failed,
  }));

  const quarantine = createMutation(() => ({
    mutationFn: (change: { readonly id: string; readonly reason: string }) =>
      quarantineMemory(agentId, change.id, change.reason),
    onSuccess: (result) => {
      quarantineOpen = false;
      const outcome = result.changed
        ? words.quarantine.outcome.done
        : words.quarantine.outcome.already;
      done(
        outcome.title,
        typeof outcome.description === 'function'
          ? outcome.description(result.affected)
          : outcome.description,
      );
      void queryClient.invalidateQueries(memoryListingsFilter(agentId));
      onQuarantined(result.id);
    },
    onError: failed,
  }));

  const exporting = createMutation(() => ({
    mutationFn: () => exportMemories(agentId),
    onSuccess: (result) => {
      downloadJson(result.memories, words.export.fileName(agentId));
      done(
        words.export.outcome.title,
        words.export.outcome.description(result.memories.length, result.exportId),
      );
    },
    onError: failed,
  }));

  /** Whether a change is being saved, read from the mutations themselves so a second press in the same tick is refused too. */
  const busy = (): boolean =>
    share.isPending || hold.isPending || quarantine.isPending || exporting.isPending;

  $effect(() => {
    pending = busy();
  });

  /** Opens the question of who to share `memory` with. */
  export function askToShare(memory: Pick<Memory, 'id' | 'content'>): void {
    if (busy()) return;
    sharing = memory;
    grantee = '';
    notice = undefined;
    shareOpen = true;
  }

  /** Places the legal hold on the memory `id`, or lifts it. */
  export function changeHold(id: string, change: 'place' | 'release'): void {
    if (busy()) return;
    notice = undefined;
    hold.mutate({ id, change });
  }

  /** Opens the question of whether, and why, to quarantine `memory`. */
  export function askToQuarantine(memory: Pick<Memory, 'id' | 'content'>): void {
    if (busy()) return;
    quarantining = memory;
    reason = '';
    notice = undefined;
    quarantineOpen = true;
  }

  /** Exports every memory of the agent to a file. */
  export function exportAll(): void {
    if (busy()) return;
    notice = undefined;
    exporting.mutate();
  }

  function submitShare(change: 'granted' | 'revoked'): void {
    if (sharing === undefined || share.isPending || grantee.trim() === '') return;
    notice = undefined;
    share.mutate({ id: sharing.id, owner: grantee.trim(), change });
  }

  function confirmQuarantine(event: SubmitEvent): void {
    event.preventDefault();
    if (quarantining === undefined || quarantine.isPending || reason.trim() === '') return;
    notice = undefined;
    quarantine.mutate({ id: quarantining.id, reason: reason.trim() });
  }

  /** The words for a fault: the governance ones first, then the correction's shared ones. */
  function refusal(fault: MemoryFault): { title: string; description: string } {
    return fault.kind === 'forbidden' ? words.refusal.forbidden : refusalWords(fault);
  }
</script>

{#if notice?.kind === 'done'}
  <Alert variant="success" dismissible onDismiss={() => (notice = undefined)}>
    <p class="ib-memory-governance__title" data-governance-outcome>{notice.title}</p>
    <p class="ib-memory-governance__body">{notice.description}</p>
  </Alert>
{:else if notice?.kind === 'failed'}
  {@const refused = refusal(notice.fault)}
  <Alert variant="danger" dismissible onDismiss={() => (notice = undefined)}>
    <p class="ib-memory-governance__title">{words.failed}</p>
    <p class="ib-memory-governance__body">{refused.description || refused.title}</p>
  </Alert>
{/if}

<Modal bind:open={shareOpen} title={words.share.dialog.title}>
  <form
    class="ib-memory-governance__form"
    onsubmit={(event) => {
      event.preventDefault();
      submitShare('granted');
    }}
  >
    <p class="ib-memory-governance__body">
      {words.share.dialog.description(excerpt(sharing?.content ?? ''))}
    </p>
    <Input id="ib-memory-grantee" label={words.share.dialog.label} bind:value={grantee} />
    <div class="ib-memory-governance__actions">
      <Button variant="secondary" onclick={() => (shareOpen = false)}
        >{words.share.dialog.cancel}</Button
      >
      <Button
        data-changes
        variant="secondary"
        disabled={share.isPending || grantee.trim() === ''}
        onclick={() => submitShare('revoked')}>{words.share.dialog.revoke}</Button
      >
      <Button type="submit" variant="primary" disabled={share.isPending || grantee.trim() === ''}
        >{words.share.dialog.submit}</Button
      >
    </div>
  </form>
</Modal>

<Modal bind:open={quarantineOpen} title={words.quarantine.dialog.title}>
  <form class="ib-memory-governance__form" onsubmit={confirmQuarantine}>
    <p class="ib-memory-governance__body">
      {words.quarantine.dialog.description(excerpt(quarantining?.content ?? ''))}
    </p>
    <Textarea
      id="ib-memory-quarantine-reason"
      label={words.quarantine.dialog.reasonLabel}
      rows={3}
      bind:value={reason}
    />
    <div class="ib-memory-governance__actions">
      <Button variant="secondary" onclick={() => (quarantineOpen = false)}
        >{words.quarantine.dialog.cancel}</Button
      >
      <Button type="submit" variant="danger" disabled={quarantine.isPending || reason.trim() === ''}
        >{words.quarantine.dialog.confirm}</Button
      >
    </div>
  </form>
</Modal>

<style>
  .ib-memory-governance__form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-memory-governance__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--cinder-space-2);
  }

  .ib-memory-governance__title {
    margin: 0;
    font-weight: 600;
  }

  .ib-memory-governance__body {
    margin: var(--cinder-space-1) 0;
  }
</style>
