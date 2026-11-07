<script lang="ts">
  /**
   * The selected key: one line saying its group, size and when it was written, its name (with how
   * long it is, when it is very long), Copy key and Copy value, and the value, which
   * `PayloadInspector` shows without a card, as fields with a switch to the JSON itself when it is a
   * JSON object, and as the value alone, quoted in the JSON view, otherwise. A key the
   * application manages shows a lock and why, and offers no Edit or Delete. Any other key can be
   * edited, where the value is text, and deleted, each after a confirmation. Edit sits in the row of
   * buttons; Delete, like every destructive action in the application, is in the "⋯" menu at the
   * end of that row.
   *
   * The pane reads the value itself when a key is opened (`storageGet`), not from the table's scan:
   * the group and the key show at once and the value is a skeleton, which after 10 s says it is
   * taking longer than usual and offers Cancel. What the pane then shows, sizes, copies and fences a
   * write on is what the read returned.
   *
   * While the editor is open the key is read again every few seconds. When the application wrote it
   * in the meantime, a warning says so and when, and nothing is overwritten silently: the person
   * discards the edit, saves over the newer value after a confirmation, or loads the new value into
   * the editor.
   *
   * The write functions refuse a managed key too, so a control that appears by mistake still cannot
   * change one.
   */
  import {
    Alert,
    Button,
    ConfirmDialog,
    CopyButton,
    Dropdown,
    formatTimeOfDay,
    Skeleton,
    Textarea,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import { Copy, Ellipsis, Lock, Pencil, Trash2 } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { getContext } from 'svelte';

  import { STORAGE_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { faultTreatment, isNetworkFailure } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { isJson, sameBytes, textOf } from './key-value.ts';
  import {
    DEFAULT_WATCH_INTERVAL_MILLISECONDS,
    STORAGE_WATCH_INTERVAL,
    storageQueryKeys,
  } from './queries.ts';
  import {
    assertWritable as assertKeyWritable,
    managedPrefix,
    WriteRefusedError,
  } from './reserved-prefix.ts';
  import {
    storageConditionalBatch,
    storageDelete,
    storageEntry,
    storageGet,
    storagePut,
    type StorageConnection,
    type StorageScanEntry,
  } from './storage-client.ts';
  import {
    keyGroupName,
    LONG_KEY_CHARACTERS,
    lockedPrefix,
    updatedPhrase,
  } from './storage-groups.ts';
  import StorageValueDisplay from './storage-value-display.svelte';

  interface Props {
    client: StorageConnection;
    entry: StorageScanEntry;
    /** The Bureau's key prefixes, or `undefined` while they are unknown: nothing is editable until they are known. */
    bureauPrefixes: readonly string[] | undefined;
    /**
     * Whether the storage can write a key only if it still holds the value this pane read
     * (`weft.storage.capabilities`). When it can, a save or a delete that finds the value changed
     * writes nothing and says so; when it cannot (`false`), the write is plain and the confirmation
     * says so; while it is not known (`undefined`), no write is made.
     */
    conditionalBatch: boolean | undefined;
    /** Called with the key after it is deleted, so the table can drop the selection if it is still that key. */
    onDeleted: (key: string) => void;
  }

  let { client, entry, bureauPrefixes, conditionalBatch, onDeleted }: Props = $props();

  const copy = STORAGE_COPY.detail;
  const queryClient = useQueryClient();
  const watchInterval =
    getContext<number | false | undefined>(STORAGE_WATCH_INTERVAL) ??
    DEFAULT_WATCH_INTERVAL_MILLISECONDS;

  const managed = $derived(
    bureauPrefixes === undefined ? undefined : managedPrefix(entry.key, bureauPrefixes),
  );
  const writable = $derived(bureauPrefixes !== undefined && managed === undefined);

  // The value as storage holds it now: `undefined` while it is read, `null` when the key is gone.
  const valueQuery = createQuery(
    () => ({
      queryKey: storageQueryKeys.value(entry.key),
      queryFn: ({ signal }) => storageGet(client, entry.key, signal),
      retry: false,
      refetchOnWindowFocus: false,
    }),
    undefined,
  );
  const stored = $derived(valueQuery.data ?? undefined);
  const text = $derived(stored === undefined ? undefined : textOf(stored));
  // TanStack puts a first read that is cancelled back to pending, so the pane keeps what it was
  // told here: the person stopped it, and "Try again" reads again.
  let stopped = $state(false);

  function stopLoading(): void {
    stopped = true;
    void queryClient.cancelQueries({ queryKey: storageQueryKeys.value(entry.key) });
  }

  function readAgain(): void {
    stopped = false;
    void valueQuery.refetch();
  }

  let editing = $state(false);
  let draft = $state('');
  let confirmSave = $state(false);
  let confirmDelete = $state(false);
  /**
   * The value the pane showed when the person opened the editor, and, separately, the delete
   * confirmation. A conditional write is fenced on its own action's snapshot, not on the entry as it
   * is at confirmation: a refetch after another writer's change replaces `entry.value`, and fencing
   * on that would let the write overwrite it. The two never share a slot, so opening one action
   * cannot move the other's fence.
   */
  let editFence = $state<Uint8Array | undefined>(undefined);
  /** When the editor was opened, or last loaded the newer value, so a read from before it is never taken for news. */
  let editStartedAt = $state(0);
  let confirmSaveOver = $state(false);
  let deleteFence = $state<Uint8Array | undefined>(undefined);

  // While the editor is open the key is read again, to see whether the application wrote it.
  const watchQuery = createQuery(
    () => ({
      queryKey: storageQueryKeys.watch(entry.key),
      queryFn: ({ signal }) => storageEntry(client, entry.key, signal),
      enabled: editing,
      // poll-reason: time-derived
      refetchInterval: watchInterval,
      refetchOnWindowFocus: watchInterval !== false,
      retry: false,
      gcTime: 0,
    }),
    undefined,
  );
  // What the key holds now when it is not what the editor opened on: read after the editor opened,
  // and different. A key that was removed is not news here; saving it finds that out.
  const newer = $derived(
    editing &&
      editFence !== undefined &&
      watchQuery.data !== undefined &&
      watchQuery.data !== null &&
      watchQuery.dataUpdatedAt >= editStartedAt &&
      !sameBytes(watchQuery.data.value, editFence)
      ? watchQuery.data
      : undefined,
  );
  const newerTime = $derived(
    newer?.updatedAt === undefined || newer.updatedAt === null
      ? null
      : formatTimeOfDay(newer.updatedAt),
  );

  const draftInvalid = $derived(editing && text !== undefined && isJson(text) && !isJson(draft));

  function startEditing(): void {
    if (stored === undefined) return;
    draft = text ?? '';
    editFence = stored;
    editStartedAt = Date.now();
    saveMutation.reset();
    editing = true;
  }

  /** Leaves the editor and shows what the key holds now. */
  async function discardEdit(): Promise<void> {
    stopEditing();
    await refresh();
  }

  /** Puts what the application wrote into the editor, in place of the edit, to be edited again. */
  async function showNewValue(): Promise<void> {
    if (newer === undefined) return;
    const next = textOf(newer.value);
    if (next === undefined) {
      await discardEdit();
      return;
    }
    draft = next;
    editFence = newer.value;
    editStartedAt = Date.now();
    saveMutation.reset();
    await refresh();
  }

  function stopEditing(): void {
    saveMutation.reset();
    editing = false;
  }

  function startDeleting(): void {
    if (stored === undefined) return;
    deleteFence = stored;
    confirmDelete = true;
  }

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: storageQueryKeys.allKeys() }),
      queryClient.invalidateQueries({ queryKey: storageQueryKeys.prefixes() }),
      // What the pane read is what was written, or gone.
      queryClient.invalidateQueries({ queryKey: storageQueryKeys.allValues() }),
      // The footer's "of N keys" and the details' key count follow what is stored.
      queryClient.invalidateQueries({ queryKey: queryKeys.hostStorageSummaries() }),
    ]);
  }

  /** What a failed write says: a refusal in its own words, anything else as the fault it is. */
  function messageOf(error: unknown): string {
    return error instanceof WriteRefusedError ? error.message : faultTreatment(error).message;
  }

  /** The sentence after the bold lead of a failed save: the cause. What became of the edit follows it. */
  function saveFailureCause(error: unknown): string {
    return isNetworkFailure(error) ? copy.saveFailed.noAnswer : messageOf(error);
  }

  /** Refuses a managed key, or any key while the managed prefixes are unknown. */
  function assertWritable(key: string): void {
    assertKeyWritable(key, bureauPrefixes, (prefix) =>
      prefix === undefined ? copy.unknownManaged : copy.managedNote(prefix),
    );
  }

  /**
   * Applies a put or a delete of `key`, only if the key still holds `expected` when the storage can
   * say so. A key that changed since the pane read it is not overwritten.
   */
  async function write(
    key: string,
    expected: Uint8Array,
    operation: { readonly type: 'put'; readonly value: Uint8Array } | { readonly type: 'delete' },
  ): Promise<void> {
    if (conditionalBatch === undefined) throw new WriteRefusedError(copy.capabilityUnknown);
    if (conditionalBatch === false) {
      if (operation.type === 'put') await storagePut(client, key, operation.value);
      else await storageDelete(client, key);
      return;
    }
    const { applied } = await storageConditionalBatch(
      client,
      [{ key, expectedValue: expected }],
      [
        operation.type === 'put'
          ? { type: 'put', key, value: operation.value }
          : { type: 'delete', key },
      ],
    );
    if (!applied) {
      // The cached entry is the stale value that fenced this write; drop it so opening the key again shows what it holds now.
      await refresh();
      // The refetch can remove this pane (another writer deleted the key), taking the error below
      // with it; a toast outlives it.
      showToast(copy.changedUnderYou, { variant: 'danger' });
      throw new WriteRefusedError(copy.changedUnderYou);
    }
  }

  const saveMutation = createMutation<
    void,
    unknown,
    { key: string; value: string; expected: Uint8Array }
  >(
    () => ({
      mutationFn: async ({ key, value, expected }) => {
        assertWritable(key);
        await write(key, expected, { type: 'put', value: new TextEncoder().encode(value) });
      },
      onSuccess: async (_result, { key }) => {
        editing = false;
        showToast(copy.saved(key), { variant: 'success' });
        await refresh();
      },
      // The failure is said once, in the alert above the editor with the draft kept; the default
      // toast would say it a second time (row 80w).
      onError: () => undefined,
    }),
    undefined,
  );

  const deleteMutation = createMutation<void, unknown, { key: string; expected: Uint8Array }>(
    () => ({
      mutationFn: async ({ key, expected }) => {
        assertWritable(key);
        await write(key, expected, { type: 'delete' });
      },
      onSuccess: async (_result, { key }) => {
        showToast(copy.deleted(key), { variant: 'success' });
        onDeleted(key);
        await refresh();
      },
    }),
    undefined,
  );

  // After a save that failed, or a rewrite, the pane's line folds the key into itself, as the
  // failed-save and rewritten frames draw it, so the line above the alert is the only thing above it.
  const saveFailed = $derived(editing && (saveMutation.isError || newer !== undefined));
  const size = $derived(stored === undefined ? undefined : formatBytes(stored.byteLength));
  const group = $derived(keyGroupName(entry.key, STORAGE_COPY.noGroup));
  // The editor is as tall as what it holds, between three lines and sixteen.
  const editorRows = $derived(Math.min(16, Math.max(3, draft.split('\n').length)));
</script>

<article class="ib-storage-key" data-testid="storage-key" aria-label={copy.label}>
  <p class="ib-storage-key__summary" data-testid="storage-key-summary">
    {#if saveFailed && size !== undefined}
      {copy.editingSummary(group, size, entry.key)}
    {:else if size !== undefined}
      {copy.summary(group, size, updatedPhrase(entry.updatedAt))}
    {:else}
      {copy.groupOnly(group)}
    {/if}
  </p>

  {#if !saveFailed}
    <p class="ib-storage-key__key">
      <span data-testid="storage-key-name">{entry.key}</span>
      {#if entry.key.length > LONG_KEY_CHARACTERS}
        <span class="ib-storage-key__length">{copy.characters(entry.key.length)}</span>
      {/if}
    </p>
  {/if}

  {#if !editing}
    <div class="ib-storage-key__actions">
      <CopyButton value={entry.key} label={copy.copyKey} disabled={valueQuery.isPending}>
        <Copy aria-hidden="true" size={14} />
        {copy.copyKey}
      </CopyButton>
      {#if stored !== undefined}
        <CopyButton value={text ?? ''} label={copy.copyValue} disabled={text === undefined}>
          <Copy aria-hidden="true" size={14} />
          {copy.copyValue}
        </CopyButton>
        {#if writable && text !== undefined}
          <Button variant="secondary" onclick={startEditing}>
            {#snippet leadingIcon()}<Pencil aria-hidden="true" size={14} />{/snippet}
            {copy.edit}
          </Button>
        {/if}
        {#if writable}
          <Dropdown id="ib-storage-key-actions" placement="bottom-end">
            <Dropdown.Trigger caretVisible={false}>
              <Ellipsis aria-hidden="true" size={16} />
              <VisuallyHidden>{copy.moreActions}</VisuallyHidden>
            </Dropdown.Trigger>
            <Dropdown.Menu>
              <Dropdown.Item data-changes variant="danger" onclick={startDeleting}>
                <Trash2 aria-hidden="true" size={14} />
                {copy.delete}
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown>
        {/if}
      {/if}
    </div>
  {/if}

  {#if managed !== undefined}
    <p class="ib-storage-key__lock" data-testid="storage-key-managed">
      <Lock aria-hidden="true" size={14} />
      <span
        >{copy.locked.before}<span class="ib-storage-key__prefix"
          >{lockedPrefix(entry.key, managed)}</span
        >{copy.locked.after}</span
      >
    </p>
  {:else if bureauPrefixes === undefined}
    <p class="ib-storage-key__lock" data-testid="storage-key-managed">
      <Lock aria-hidden="true" size={14} />
      <span>{copy.unknownManaged}</span>
    </p>
  {/if}

  {#if deleteMutation.isError}
    <Alert variant="danger">
      <p class="ib-storage-key__alert">{copy.deleteFailed}</p>
      <p>{messageOf(deleteMutation.error)}</p>
    </Alert>
  {/if}

  {#if stored === undefined}
    {#if stopped}
      <p class="ib-storage-key__note" data-testid="storage-key-stopped">{copy.valueStopped}</p>
      <div class="ib-storage-key__actions">
        <Button variant="secondary" onclick={readAgain}>{copy.valueRetry}</Button>
      </div>
    {:else if valueQuery.isError}
      <Alert variant="danger">
        <p class="ib-storage-key__alert-line">
          <strong>{copy.valueFailed}</strong>
          {isNetworkFailure(valueQuery.error)
            ? copy.saveFailed.noAnswer
            : faultTreatment(valueQuery.error).message}
        </p>
      </Alert>
      <div class="ib-storage-key__actions">
        <Button variant="secondary" onclick={readAgain}>{copy.valueRetry}</Button>
      </div>
    {:else if valueQuery.data === null}
      <p class="ib-storage-key__note" data-testid="storage-key-gone">{copy.valueGone}</p>
    {:else}
      <div data-testid="storage-key-loading">
        <Skeleton
          lines={4}
          delay={300}
          stillLoadingAfter={10_000}
          label={copy.valueLoadingLabel}
          onCancel={stopLoading}
        />
      </div>
    {/if}
  {:else if editing}
    <div class="ib-storage-key__edit">
      {#if newer !== undefined}
        <Alert variant="warning">
          <p class="ib-storage-key__alert-line" data-testid="storage-rewritten">
            <strong>{copy.rewritten.lead}</strong>
            <span>{copy.rewritten.detail(newerTime)}</span>
          </p>
        </Alert>
      {:else if saveMutation.isError}
        <Alert variant="danger">
          <p class="ib-storage-key__alert-line" data-testid="storage-save-failed">
            <strong>{copy.saveFailed.lead}</strong>
            <span>{saveFailureCause(saveMutation.error)}</span>
            <span>{copy.saveFailed.kept}</span>
          </p>
        </Alert>
      {/if}
      <!-- After a failed save the editor sits straight under the alert, as the failed-save frame draws it, and keeps its name for assistive technology. -->
      <Textarea
        id="ib-storage-edit"
        variant="code"
        rows={editorRows}
        bind:value={draft}
        {...saveFailed ? { 'aria-label': copy.editLabel } : { label: copy.editLabel }}
        {...draftInvalid ? { error: copy.notJson } : {}}
      />
      {#if newer !== undefined}
        <!-- The three ways on sit in one row under the editor, as the rewritten frame draws them, not inside the alert. Small buttons keep the row on one line in the detail pane at 1280 pixels. -->
        <div class="ib-storage-key__actions ib-storage-key__actions--end">
          <Button size="sm" variant="secondary" onclick={discardEdit}
            >{copy.rewritten.discard}</Button
          >
          <Button
            size="sm"
            data-changes
            variant="secondary"
            loading={saveMutation.isPending}
            onclick={() => (confirmSaveOver = true)}>{copy.rewritten.saveOver}</Button
          >
          <Button size="sm" variant="primary" onclick={showNewValue}
            >{copy.rewritten.showNew}</Button
          >
        </div>
      {:else}
        <div class="ib-storage-key__actions ib-storage-key__actions--end">
          <Button variant="secondary" onclick={stopEditing}>{copy.cancel}</Button>
          <Button
            data-changes
            variant="primary"
            disabled={draftInvalid || draft === text}
            loading={saveMutation.isPending}
            onclick={() => (confirmSave = true)}>{copy.save}</Button
          >
        </div>
      {/if}
    </div>
  {:else if text === undefined}
    <StorageValueDisplay value={stored} label={copy.valueLabel} />
    {#if writable}
      <p class="ib-storage-key__note">{copy.binaryNote}</p>
    {/if}
  {:else}
    <StorageValueDisplay value={stored} label={copy.valueLabel} />
  {/if}
</article>

<ConfirmDialog
  bind:open={confirmSave}
  title={STORAGE_COPY.confirmSave.title}
  description={STORAGE_COPY.confirmSave.description(entry.key, conditionalBatch === false)}
  confirmLabel={STORAGE_COPY.confirmSave.confirm}
  onConfirm={() => {
    if (editFence !== undefined) {
      saveMutation.mutate({ key: entry.key, value: draft, expected: editFence });
    }
  }}
/>

<ConfirmDialog
  bind:open={confirmSaveOver}
  title={STORAGE_COPY.confirmSaveOver.title}
  description={STORAGE_COPY.confirmSaveOver.description(
    entry.key,
    newerTime,
    conditionalBatch === false,
  )}
  confirmLabel={STORAGE_COPY.confirmSaveOver.confirm}
  onConfirm={() => {
    if (newer !== undefined) {
      saveMutation.mutate({ key: entry.key, value: draft, expected: newer.value });
    }
  }}
/>

{#snippet deleteDescription()}
  <span class="ib-storage-key__prefix ib-storage-key__dialog-key">{entry.key}</span
  >{STORAGE_COPY.confirmDelete.afterKey(size ?? '', conditionalBatch === false)}
{/snippet}

<ConfirmDialog
  bind:open={confirmDelete}
  title={STORAGE_COPY.confirmDelete.title}
  description={deleteDescription}
  confirmLabel={STORAGE_COPY.confirmDelete.confirm}
  destructive
  onConfirm={() => {
    if (deleteFence !== undefined) deleteMutation.mutate({ key: entry.key, expected: deleteFence });
  }}
>
  {#snippet confirmIcon()}<Trash2 aria-hidden="true" size={14} />{/snippet}
</ConfirmDialog>

<style>
  .ib-storage-key {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-storage-key__summary {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* A key can be thousands of characters with no break in it: wrap it wherever it is, here, where
   * the whole key is the point, and cut it short only in the table. */
  .ib-storage-key__key {
    margin: calc(var(--cinder-space-3) * -1) 0 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-storage-key__prefix {
    font-family: var(--cinder-font-mono);
  }

  .ib-storage-key__length {
    color: var(--cinder-text-muted);
  }

  .ib-storage-key__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-storage-key__actions--end {
    justify-content: flex-end;
  }

  .ib-storage-key__lock {
    display: flex;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* The lock keeps its size beside a line that wraps, and sits on the first line's middle. */
  .ib-storage-key__lock > :global(svg) {
    flex: none;
    margin-block-start: 0.2em;
  }

  .ib-storage-key__alert {
    margin: 0;
    font-weight: 600;
  }

  /* One line with a bold lead sentence, then the cause, as every failed-save alert reads. */
  .ib-storage-key__alert-line {
    margin: 0;
  }

  .ib-storage-key__alert-line > strong {
    font-weight: 600;
  }

  .ib-storage-key__dialog-key {
    overflow-wrap: anywhere;
  }

  .ib-storage-key__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-storage-key__edit {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }
</style>
