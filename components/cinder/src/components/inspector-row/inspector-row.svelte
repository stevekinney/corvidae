<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose One property row of an inspector: a muted label, a value and a trailing affordance; an editable row opens an inline editor or a popover on activation and commits or cancels from the keyboard.
   * @tag properties
   * @tag editable
   * @tag row
   * @useWhen Showing one property of a record as a quiet row that becomes a text, select, date or toggle editor on activation.
   * @useWhen Opening a custom editor, such as a picker, in a popover anchored to the row's value.
   * @avoidWhen The value is read-only and needs no affordance at all — use description-list.
   * @avoidWhen The control belongs beside a setting's description and save status — use setting-row.
   * @related inspector, description-list, setting-row, popover
   * @rationale Nearest alternative: SettingRow — an inspector row is a quiet label and value that turns into an editor on activation, where a setting row always shows its control.
   */
  export type {
    InspectorRowEditorContext,
    InspectorRowKind,
    InspectorRowOption,
    InspectorRowProps,
    InspectorRowValue,
  } from './inspector-row.types.ts';
</script>

<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { tick } from 'svelte';

  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { default as Popover } from '../popover/index.ts';
  import type { InspectorRowProps, InspectorRowValue } from './inspector-row.types.ts';

  let {
    label,
    icon,
    value,
    kind,
    current,
    options = [],
    editor,
    editLabel,
    disabled = false,
    suggested = false,
    suggestedLabel = 'Suggested',
    onCommit,
    onCancel,
    class: className,
    ...rest
  }: InspectorRowProps = $props();

  const generatedId = $props.id();
  const labelId = `${generatedId}-label`;
  const valueId = `${generatedId}-value`;

  // A custom editor wins over a built-in kind; a disabled row is read-only whatever it carries.
  const editable = $derived(!disabled && (editor !== undefined || kind !== undefined));
  const toggles = $derived(editable && editor === undefined && kind === 'toggle');
  const hasPopover = $derived(editable && editor !== undefined);
  const inlineKind = $derived(
    editable && editor === undefined && kind !== undefined && kind !== 'toggle' ? kind : undefined,
  );
  const resolvedEditLabel = $derived(editLabel ?? `Edit ${label}`);

  let editing = $state(false);
  let draft = $state('');
  let trigger: HTMLButtonElement | null = $state(null);
  let textField: HTMLInputElement | null = $state(null);
  let dateField: HTMLInputElement | null = $state(null);
  let selectField: HTMLSelectElement | null = $state(null);
  // Set once an edit has been committed or cancelled, so a later close is not reported twice.
  let settled = false;
  let wasEditing = false;

  function restoreFocus(): void {
    void tick().then(() => trigger?.focus({ preventScroll: true }));
  }

  function begin(): void {
    settled = false;
    draft = typeof current === 'string' ? current : '';
    editing = true;
  }

  function commit(next?: InspectorRowValue): void {
    if (!editing) return;
    settled = true;
    editing = false;
    onCommit?.(next);
    restoreFocus();
  }

  function cancel(): void {
    if (!editing) return;
    settled = true;
    editing = false;
    onCancel?.();
    restoreFocus();
  }

  function activate(): void {
    if (!editable) return;
    if (toggles) {
      onCommit?.(current !== true);
      return;
    }
    if (editing) {
      cancel();
      return;
    }
    begin();
  }

  function handleTextKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit(draft);
  }

  function handleSelectKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit(selectField?.value ?? draft);
  }

  // The popover closes itself on Escape and on an outside press; report that as a cancel.
  $effect(() => {
    if (editing) {
      wasEditing = true;
      return;
    }
    if (!wasEditing) return;
    wasEditing = false;
    if (settled) return;
    settled = true;
    onCancel?.();
  });

  // An inline editor joins the shared Escape stack, so Escape cancels it before it can close an
  // enclosing dialog or drawer.
  $effect(() => {
    if (!editing || inlineKind === undefined) return;
    return pushEscapeHandler((event) => {
      event.preventDefault();
      cancel();
    });
  });

  // Focus moves into the inline editor as it opens, with a text value selected.
  $effect(() => {
    if (!editing) return;
    const field = textField ?? dateField ?? selectField;
    if (!field) return;
    field.focus({ preventScroll: true });
    if (field instanceof HTMLInputElement && field.type === 'text') field.select();
  });
</script>

<div
  {...rest}
  class={classNames('cinder-inspector-row', className)}
  data-cinder-editable={editable ? '' : undefined}
  data-cinder-readonly={editable ? undefined : ''}
  data-cinder-editing={editing ? '' : undefined}
  data-cinder-suggested={suggested ? '' : undefined}
>
  <dt id={labelId} class="cinder-inspector-row__label">
    {#if icon}
      <span class="cinder-inspector-row__icon" aria-hidden="true">{@render icon()}</span>
    {/if}
    <span class="cinder-inspector-row__label-text">{label}</span>
    {#if suggested}
      <span class="cinder-inspector-row__suggested">{suggestedLabel}</span>
    {/if}
  </dt>
  <dd class="cinder-inspector-row__value">
    {#if editing && inlineKind === 'select'}
      <select
        bind:this={selectField}
        class="cinder-inspector-row__field"
        aria-label={resolvedEditLabel}
        value={draft}
        onchange={(event) => commit(event.currentTarget.value)}
        onkeydown={handleSelectKeydown}
        onblur={() => commit(selectField?.value ?? draft)}
      >
        {#each options as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    {:else if editing && inlineKind === 'date'}
      <input
        bind:this={dateField}
        bind:value={draft}
        class="cinder-inspector-row__field"
        type="date"
        aria-label={resolvedEditLabel}
        onkeydown={handleTextKeydown}
        onblur={() => commit(draft)}
      />
    {:else if editing && inlineKind === 'text'}
      <input
        bind:this={textField}
        bind:value={draft}
        class="cinder-inspector-row__field"
        type="text"
        aria-label={resolvedEditLabel}
        autocomplete="off"
        onkeydown={handleTextKeydown}
        onblur={() => commit(draft)}
      />
    {:else if editable}
      <button
        bind:this={trigger}
        type="button"
        class="cinder-inspector-row__trigger"
        role={toggles ? 'switch' : undefined}
        aria-checked={toggles ? current === true : undefined}
        aria-haspopup={hasPopover ? 'dialog' : undefined}
        aria-expanded={hasPopover ? editing : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onclick={activate}
      >
        <span id={valueId} class="cinder-inspector-row__text">{@render value()}</span>
        {#if toggles}
          <span
            class="cinder-inspector-row__switch"
            data-cinder-checked={current === true ? '' : undefined}
            aria-hidden="true"
          ></span>
        {:else}
          <span class="cinder-inspector-row__chevron" aria-hidden="true">
            <ChevronRight size={16} />
          </span>
        {/if}
      </button>
    {:else}
      <span id={valueId} class="cinder-inspector-row__text">{@render value()}</span>
    {/if}
    {#if hasPopover}
      <Popover
        bind:open={editing}
        triggerRef={trigger}
        label={resolvedEditLabel}
        placement="bottom-start"
      >
        {@render editor?.({ commit, cancel })}
      </Popover>
    {/if}
  </dd>
</div>
