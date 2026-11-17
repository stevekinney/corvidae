<script lang="ts" module>
  /** @cinder
   * @category data-display
   * @status beta
   * @purpose Edits string key/value pairs and masks values selected as secrets.
   * @tag key-value-editor
   * @useWhen Editing headers, environment variables, or configuration fields.
   * @avoidWhen Values need rich structured content; use Table.
   * @related secret-value-field, table
   * @rationale Nearest alternative: SecretValueField displays one secret; this owns pair editing.
   */
  export type { KeyValueEditorProps, KeyValueEntry } from './key-value-editor.types.ts';
</script>

<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { tick } from 'svelte';
  import { default as Button } from '../button/index.ts';
  import { default as Input } from '../input/index.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import type { KeyValueEditorProps, KeyValueEntry } from './key-value-editor.types.ts';
  let {
    entries = $bindable([]),
    onValueChange,
    secret,
    addLabel = 'Add pair',
    removeLabel = (key) => `Remove ${key || 'pair'}`,
    label,
    description,
    keyLabel = 'Key',
    valueLabel = 'Value',
    monospace = false,
    class: className,
    ...rest
  }: KeyValueEditorProps = $props();
  const instanceId = $props.id();
  let rows = $state<KeyValueEntry[]>(entries);
  let editorElement = $state<HTMLDivElement>();
  let lastExternalEntries = entries;
  // The empty row after the last pair. It is not in `entries` until a person types into it; its id
  // is minted up front, so the first keystroke turns it into a real row in the same keyed slot and
  // the input being typed into keeps its DOM node and focus.
  let pendingId = $state(crypto.randomUUID());
  const shownRows = $derived([...rows, { id: pendingId, key: '', value: '' }]);
  // The id of the row whose key input, value input, or remove control held
  // focus immediately before the current `entries` update patches the DOM —
  // captured in `$effect.pre` below, since a parent-removed row's DOM node
  // may have already lost focus by the time the regular `$effect` runs.
  let focusedRowIdBeforePatch: string | null = null;
  function commit(next: KeyValueEntry[]) {
    rows = next;
    lastExternalEntries = next;
    entries = next;
    onValueChange?.(next);
  }
  function update(id: string, field: 'key' | 'value', value: string) {
    if (id === pendingId) {
      // Typing into the empty row adds it as a pair, and a new empty row takes its place.
      const added: KeyValueEntry = { id, key: '', value: '', [field]: value };
      pendingId = crypto.randomUUID();
      commit([...rows, added]);
      return;
    }
    commit(rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }
  function focusedRowId(): string | null {
    const active = document.activeElement;
    if (!active || !editorElement?.contains(active)) return null;
    return active.closest<HTMLElement>('[data-cinder-row-id]')?.dataset['cinderRowId'] ?? null;
  }
  async function focusRemoveFallback(removedIndex: number): Promise<void> {
    await tick();
    const target =
      rows.length === 0
        ? editorElement?.querySelector<HTMLElement>(
            '.cinder-key-value-editor__row[data-cinder-pending] input',
          )
        : editorElement?.querySelectorAll<HTMLButtonElement>('.cinder-key-value-editor__remove')[
            Math.min(removedIndex - 1 >= 0 ? removedIndex - 1 : removedIndex, rows.length - 1)
          ];
    target?.focus();
  }
  async function removeRow(index: number): Promise<void> {
    commit(rows.filter((_, i) => i !== index));
    await focusRemoveFallback(index);
  }
  $effect.pre(() => {
    void entries;
    focusedRowIdBeforePatch = focusedRowId();
  });
  $effect(() => {
    if (entries === lastExternalEntries) return;
    const previousRows = rows;
    rows = entries;
    lastExternalEntries = entries;

    const focusedId = focusedRowIdBeforePatch;
    if (focusedId === null || shownRows.some((row) => row.id === focusedId)) return;

    // The parent removed the row that held focus: fall back to the previous
    // row's Remove control, else the next row's, else the empty row — the same
    // policy user-triggered removal already uses.
    const formerIndex = previousRows.findIndex((row) => row.id === focusedId);
    if (formerIndex !== -1) void focusRemoveFallback(formerIndex);
  });
</script>

<div
  bind:this={editorElement}
  {...rest}
  role={label ? 'group' : undefined}
  aria-labelledby={label ? `${instanceId}-label` : undefined}
  aria-describedby={description ? `${instanceId}-description` : undefined}
  class={classNames('cinder-key-value-editor', className)}
>
  {#if label}
    <div id={`${instanceId}-label`} class="cinder-key-value-editor__label">{label}</div>
  {/if}
  <!-- The column headings are for sight only: every box carries its own accessible name. -->
  <div class="cinder-key-value-editor__headings" aria-hidden="true">
    <span>{keyLabel}</span>
    <span>{valueLabel}</span>
  </div>
  <div class="cinder-key-value-editor__rows" role="list">
    {#each shownRows as row, index (row.id)}
      {@const pending = row.id === pendingId}
      <div
        class="cinder-key-value-editor__row"
        role="listitem"
        data-cinder-row-id={row.id}
        data-cinder-pending={pending ? '' : undefined}
      >
        <Input
          id={`${instanceId}-key-${row.id}`}
          label={keyLabel}
          labelVisible={false}
          variant={monospace ? 'code' : 'default'}
          aria-describedby={pending ? `${instanceId}-add` : undefined}
          value={row.key}
          onValueChange={(next) => update(row.id, 'key', next)}
        />
        <Input
          id={`${instanceId}-value-${row.id}`}
          label={valueLabel}
          labelVisible={false}
          variant={monospace ? 'code' : 'default'}
          aria-describedby={pending ? `${instanceId}-add` : undefined}
          type={secret?.(row.key) ? 'password' : 'text'}
          value={row.value}
          onValueChange={(next) => update(row.id, 'value', next)}
        />
        {#if !pending}
          <Button
            variant="ghost"
            iconOnly
            quiet
            class="cinder-key-value-editor__remove"
            aria-label={removeLabel(row.key)}
            onclick={() => removeRow(index)}
          >
            <X aria-hidden="true" />
          </Button>
        {/if}
      </div>
    {/each}
  </div>
  <span id={`${instanceId}-add`} class="cinder-sr-only">{addLabel}</span>
  {#if description}
    <p id={`${instanceId}-description`} class="cinder-key-value-editor__description">
      {description}
    </p>
  {/if}
</div>
