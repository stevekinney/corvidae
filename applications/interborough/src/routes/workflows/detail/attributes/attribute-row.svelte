<script lang="ts">
  /**
   * One search attribute: its key and value, and, where the principal may change it, an editor in
   * the value's current type. The row validates what the editor holds (a number must be a number, a
   * date must parse) and hands a value of the right type to `onSave`; whether the save lands, and what
   * a refusal says, is the panel's.
   */
  import { Badge, Button, Input, TagInput, Toggle } from '@lostgradient/cinder';

  import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
  import { parseEditedValue, type AttributeEntry, type AttributeValue } from './attributes-data.ts';

  interface AttributeRowProps {
    readonly entry: AttributeEntry;
    /** Whether the principal holds `attributes:write`. An engine-owned key is never editable either way. */
    readonly canWrite: boolean;
    /** Resolves `true` once the value is saved, `false` when it was refused (the panel shows why). */
    readonly onSave: (key: string, value: AttributeValue) => Promise<boolean>;
  }

  let { entry, canWrite, onSave }: AttributeRowProps = $props();

  const copy = RUN_DETAIL_COPY.attributes;
  const editable = $derived(canWrite && !entry.engineOwned);

  let editing = $state(false);
  let saving = $state(false);
  let invalid = $state<string | null>(null);

  // One draft per editor type; only the one for `entry.kind` is read.
  let textDraft = $state('');
  let booleanDraft = $state(false);
  let listDraft = $state<string[]>([]);

  function startEditing(): void {
    textDraft =
      typeof entry.value === 'string' || typeof entry.value === 'number' ? String(entry.value) : '';
    booleanDraft = entry.value === true;
    listDraft = Array.isArray(entry.value) ? [...(entry.value as readonly string[])] : [];
    invalid = null;
    editing = true;
  }

  function stopEditing(): void {
    editing = false;
    invalid = null;
  }

  async function save(): Promise<void> {
    const draft =
      entry.kind === 'boolean' ? booleanDraft : entry.kind === 'list' ? listDraft : textDraft;
    const parsed = parseEditedValue(entry.kind, draft);
    if (!parsed.ok) {
      invalid = parsed.reason === 'number' ? copy.invalidNumber : copy.invalidDate;
      return;
    }
    invalid = null;
    saving = true;
    try {
      if (await onSave(entry.key, parsed.value)) editing = false;
    } finally {
      saving = false;
    }
  }

  const id = $derived(`weft-attribute-${entry.key}`);
</script>

<li
  class="weft-attribute-row"
  data-attribute-key={entry.key}
  data-engine-owned={entry.engineOwned ? 'true' : 'false'}
>
  <div class="weft-attribute-row__summary">
    <span class="weft-attribute-row__key">{entry.key}</span>
    <span class="weft-attribute-row__value" data-kind={entry.kind}>
      {#if Array.isArray(entry.value)}
        {#each entry.value as item, index (index)}
          <Badge variant="neutral">{item}</Badge>
        {/each}
      {:else}
        {String(entry.value)}
      {/if}
    </span>
    {#if entry.engineOwned}
      <span class="weft-attribute-row__note">{copy.engineOwned}</span>
    {:else if editable && !editing}
      <Button variant="ghost" size="sm" label={copy.edit(entry.key)} onclick={startEditing} />
    {/if}
  </div>

  {#if editing}
    <div class="weft-attribute-row__editor">
      {#if entry.kind === 'boolean'}
        <Toggle {id} label={entry.key} bind:checked={booleanDraft} />
      {:else if entry.kind === 'list'}
        <TagInput {id} aria-label={entry.key} bind:value={listDraft} />
      {:else}
        <Input
          {id}
          label={entry.key}
          labelVisible={false}
          type={entry.kind === 'number' ? 'number' : 'text'}
          bind:value={textDraft}
          error={invalid ?? ''}
        />
      {/if}
      {#if invalid !== null && entry.kind !== 'number' && entry.kind !== 'date' && entry.kind !== 'string'}
        <p class="weft-attribute-row__invalid">{invalid}</p>
      {/if}
      <div class="weft-attribute-row__actions">
        <Button
          variant="primary"
          size="sm"
          label={copy.save(entry.key)}
          loading={saving}
          disabled={saving}
          onclick={() => void save()}
        />
        <Button
          variant="ghost"
          size="sm"
          label={copy.cancel(entry.key)}
          disabled={saving}
          onclick={stopEditing}
        />
      </div>
    </div>
  {/if}
</li>

<style>
  .weft-attribute-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 9px 0;
    border-top: 1px solid var(--cinder-border);
    list-style: none;
  }

  .weft-attribute-row:first-child {
    border-top: 0;
  }

  .weft-attribute-row__summary {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .weft-attribute-row__key {
    flex: 0 0 11rem;
    max-width: 100%;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    overflow-wrap: anywhere;
  }

  .weft-attribute-row__value {
    flex: 1 1 10rem;
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-attribute-row__note {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-attribute-row__editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-attribute-row__actions {
    display: flex;
    gap: 8px;
  }

  .weft-attribute-row__invalid {
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-status-danger-text);
  }
</style>
