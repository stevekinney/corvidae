<script lang="ts">
  /**
   * The selected key: its group, size and name, Copy key and Copy value, and the value, which
   * `PayloadInspector` shows as fields with a switch to the JSON itself when it is a JSON object, and
   * as it is otherwise. A key the
   * application manages shows a lock and why, and offers no Edit or Delete. Any other key can be
   * edited, where the value is text, and deleted, each after a confirmation.
   *
   * The write functions refuse a managed key too, so a control that appears by mistake still cannot
   * change one.
   */
  import { Alert, Button, ConfirmDialog, CopyButton, Textarea } from '@lostgradient/cinder';
  import { Lock, Pencil, Trash2 } from '@lucide/svelte';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { STORAGE_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { faultTreatment } from '../../lib/faults.ts';
  import { formatBytes } from '../../lib/format/index.ts';
  import { isJson, textOf } from './key-value.ts';
  import { keyGroup } from './prefix-discovery.ts';
  import { storageQueryKeys } from './queries.ts';
  import {
    assertWritable as assertKeyWritable,
    managedPrefix,
    WriteRefusedError,
  } from './reserved-prefix.ts';
  import {
    storageConditionalBatch,
    storageDelete,
    storagePut,
    type StorageConnection,
    type StorageScanEntry,
  } from './storage-client.ts';
  import StorageValueDisplay from './storage-value-display.svelte';

  interface Props {
    client: StorageConnection;
    entry: StorageScanEntry;
    /** The Bureau's key prefixes, or `undefined` while they are unknown: nothing is editable until they are known. */
    bureauPrefixes: readonly string[] | undefined;
    /**
     * Whether the storage can write a key only if it still holds the value this pane read
     * (`weft.storage.capabilities`). When it can, a save or a delete that finds the value changed
     * writes nothing and says so; when it cannot, or is not known, the write is plain.
     */
    conditionalBatch: boolean | undefined;
    /** Called with the key after it is deleted, so the table can drop the selection if it is still that key. */
    onDeleted: (key: string) => void;
  }

  let { client, entry, bureauPrefixes, conditionalBatch, onDeleted }: Props = $props();

  const copy = STORAGE_COPY.detail;
  const queryClient = useQueryClient();

  const managed = $derived(
    bureauPrefixes === undefined ? undefined : managedPrefix(entry.key, bureauPrefixes),
  );
  const writable = $derived(bureauPrefixes !== undefined && managed === undefined);
  const text = $derived(textOf(entry.value));

  let editing = $state(false);
  let draft = $state('');
  let confirmSave = $state(false);
  let confirmDelete = $state(false);

  const draftInvalid = $derived(editing && text !== undefined && isJson(text) && !isJson(draft));

  function startEditing(): void {
    draft = text ?? '';
    editing = true;
  }

  async function refresh(): Promise<void> {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: storageQueryKeys.allKeys() }),
      queryClient.invalidateQueries({ queryKey: storageQueryKeys.prefixes() }),
    ]);
  }

  /** What a failed write says: a refusal in its own words, anything else as the fault it is. */
  function messageOf(error: unknown): string {
    return error instanceof WriteRefusedError ? error.message : faultTreatment(error).message;
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
    if (conditionalBatch !== true) {
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
    if (!applied) throw new WriteRefusedError(copy.changedUnderYou);
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
</script>

<article class="ib-storage-key" data-testid="storage-key" aria-label={copy.label}>
  <dl class="ib-storage-key__facts">
    <div>
      <dt>{copy.group}</dt>
      <dd>{keyGroup(entry.key) ?? STORAGE_COPY.noGroup}</dd>
    </div>
    <div>
      <dt>{copy.size}</dt>
      <dd>{formatBytes(entry.value.byteLength)}</dd>
    </div>
  </dl>

  <div class="ib-storage-key__name">
    <h3 class="ib-storage-key__heading">{copy.key}</h3>
    <p class="ib-storage-key__key" data-testid="storage-key-name">{entry.key}</p>
  </div>

  <div class="ib-storage-key__actions">
    <CopyButton value={entry.key} label={copy.copyKey} />
    <CopyButton value={text ?? ''} label={copy.copyValue} disabled={text === undefined} />
    {#if writable && !editing && text !== undefined}
      <Button variant="secondary" onclick={startEditing}>
        {#snippet leadingIcon()}<Pencil aria-hidden="true" size={14} />{/snippet}
        {copy.edit}
      </Button>
    {/if}
    {#if writable}
      <Button data-changes variant="danger" onclick={() => (confirmDelete = true)}>
        {#snippet leadingIcon()}<Trash2 aria-hidden="true" size={14} />{/snippet}
        {copy.delete}
      </Button>
    {/if}
  </div>

  {#if managed !== undefined}
    <p class="ib-storage-key__lock" data-testid="storage-key-managed">
      <Lock aria-hidden="true" size={14} />
      <span>{copy.managedNote(managed)}</span>
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

  {#if editing}
    <div class="ib-storage-key__edit">
      <Textarea
        id="ib-storage-edit"
        label={copy.editLabel}
        variant="code"
        rows={10}
        bind:value={draft}
        {...draftInvalid ? { error: copy.notJson } : {}}
      />
      {#if saveMutation.isError}
        <Alert variant="danger">
          <p class="ib-storage-key__alert">{copy.saveFailed}</p>
          <p>{messageOf(saveMutation.error)}</p>
        </Alert>
      {/if}
      <div class="ib-storage-key__actions">
        <Button
          data-changes
          variant="primary"
          disabled={draftInvalid || draft === text}
          loading={saveMutation.isPending}
          onclick={() => (confirmSave = true)}>{copy.save}</Button
        >
        <Button variant="secondary" onclick={() => (editing = false)}>{copy.cancel}</Button>
      </div>
    </div>
  {:else if text === undefined}
    <StorageValueDisplay value={entry.value} label={copy.valueLabel} />
    {#if writable}
      <p class="ib-storage-key__note">{copy.binaryNote}</p>
    {/if}
  {:else}
    <StorageValueDisplay value={entry.value} label={copy.valueLabel} />
  {/if}
</article>

<ConfirmDialog
  bind:open={confirmSave}
  title={STORAGE_COPY.confirmSave.title}
  description={STORAGE_COPY.confirmSave.description(entry.key)}
  confirmLabel={STORAGE_COPY.confirmSave.confirm}
  onConfirm={() => saveMutation.mutate({ key: entry.key, value: draft, expected: entry.value })}
/>

<ConfirmDialog
  bind:open={confirmDelete}
  title={STORAGE_COPY.confirmDelete.title}
  description={STORAGE_COPY.confirmDelete.description(entry.key)}
  confirmLabel={STORAGE_COPY.confirmDelete.confirm}
  destructive
  onConfirm={() => deleteMutation.mutate({ key: entry.key, expected: entry.value })}
/>

<style>
  .ib-storage-key {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-storage-key__facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-5);
    margin: 0;
  }

  .ib-storage-key__facts dt,
  .ib-storage-key__heading {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    font-weight: 400;
  }

  .ib-storage-key__facts dd {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-storage-key__name {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  /* A key can be thousands of characters with no break in it: wrap it wherever it is, here, where
   * the whole key is the point, and cut it short only in the table. */
  .ib-storage-key__key {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-storage-key__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-storage-key__lock {
    display: flex;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-storage-key__alert {
    margin: 0;
    font-weight: 600;
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
