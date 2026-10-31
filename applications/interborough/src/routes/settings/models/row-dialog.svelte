<script lang="ts">
  /**
   * Edit one row of the model catalog (its context window, its largest answer and its price), or add
   * a row the built-in list lacks. Neither writes anything: Apply hands the values to the table,
   * which keeps them with its other unsaved edits until Save sends them all at once. The values are
   * checked here for the mistakes a form can see; the host checks them again against the whole
   * catalog when they are saved.
   */
  import { Button, Input, Modal, NumberInput, Select } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { providerDisplayName } from './format-model.ts';
  import {
    namesExistingRow,
    type AddedRow,
    type PreviewRow,
    type RowFields,
  } from './catalog-changes.ts';

  /** What the dialog is open for: a row to edit, a new row, or nothing. */
  export type RowDialogTarget =
    { readonly kind: 'edit'; readonly row: PreviewRow } | { readonly kind: 'add' };

  interface Props {
    /** What the dialog is for, or `null` while it is closed. */
    target: RowDialogTarget | null;
    /** Every row the table shows, which an added row may be based on and may not repeat. */
    rows: readonly PreviewRow[];
    /** The providers a row may be added to: the connected ones. */
    providers: readonly string[];
    onEdit: (row: PreviewRow, fields: RowFields) => void;
    onAdd: (added: AddedRow) => void;
  }

  let { target = $bindable(), rows, providers, onEdit, onAdd }: Props = $props();

  const copy = MODELS_COPY.rowDialog;

  let provider = $state('');
  let model = $state('');
  let basedOn = $state('');
  let contextWindowTokens = $state<number | null>(null);
  let maxOutputTokens = $state<number | null>(null);
  let inputPrice = $state<number | null>(null);
  let outputPrice = $state<number | null>(null);
  let errors = $state<Readonly<Record<string, string>>>({});

  const baseChoices = $derived(
    rows.filter((row) => row.provider === provider && !row.added).map((row) => row.model),
  );

  function load(row: PreviewRow): void {
    contextWindowTokens = row.contextWindowTokens;
    maxOutputTokens = row.maxOutputTokens;
    inputPrice = row.pricing?.inputPerMillionTokens ?? null;
    outputPrice = row.pricing?.outputPerMillionTokens ?? null;
  }

  /** Starts the form over from what it is open for. */
  function start(next: RowDialogTarget | null): void {
    errors = {};
    model = '';
    if (next === null) return;
    if (next.kind === 'edit') {
      provider = next.row.provider;
      basedOn = '';
      load(next.row);
      return;
    }
    provider = providers[0] ?? '';
    chooseBase(rows.find((row) => row.provider === provider && !row.added));
  }

  function chooseBase(row: PreviewRow | undefined): void {
    basedOn = row?.model ?? '';
    if (row !== undefined) load(row);
  }

  $effect(() => {
    const next = target;
    untrack(() => start(next));
  });

  function wholeNumber(value: number | null): value is number {
    return value !== null && Number.isSafeInteger(value) && value > 0;
  }

  function price(value: number | null): value is number {
    return value !== null && Number.isFinite(value) && value >= 0;
  }

  /** The problems with what was typed, by field; empty when it can be applied. */
  function problems(adding: boolean): Record<string, string> {
    const found: Record<string, string> = {};
    if (adding) {
      if (model.trim() === '') found['model'] = copy.modelRequired;
      else if (namesExistingRow(rows, provider, model.trim())) found['model'] = copy.modelExists;
      if (basedOn === '') found['basedOn'] = copy.basedOnRequired;
    }
    if (!wholeNumber(contextWindowTokens)) found['context'] = copy.wholeNumber;
    if (!wholeNumber(maxOutputTokens)) found['output'] = copy.wholeNumber;
    else if (wholeNumber(contextWindowTokens) && maxOutputTokens > contextWindowTokens) {
      found['output'] = copy.outputTooLarge;
    }
    if (!price(inputPrice)) found['input'] = copy.price;
    if (!price(outputPrice)) found['outputPrice'] = copy.price;
    return found;
  }

  function apply(): void {
    const current = target;
    if (current === null) return;
    const found = problems(current.kind === 'add');
    errors = found;
    if (Object.keys(found).length > 0) return;
    const fields: RowFields = {
      contextWindowTokens: contextWindowTokens ?? 0,
      maxOutputTokens: maxOutputTokens ?? 0,
      inputPerMillionTokens: inputPrice ?? 0,
      outputPerMillionTokens: outputPrice ?? 0,
    };
    if (current.kind === 'edit') onEdit(current.row, fields);
    else onAdd({ ...fields, provider, model: model.trim(), basedOn });
    target = null;
  }

  function close(): void {
    target = null;
  }

  const adding = $derived(target?.kind === 'add');
  const title = $derived(
    target?.kind === 'edit' ? copy.editTitle(target.row.model) : copy.addTitle,
  );
</script>

<Modal open={target !== null} {title} onDismiss={close}>
  {#snippet children()}
    <form
      class="ib-row-dialog"
      data-testid="model-row-form"
      onsubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      {#if adding}
        <p class="ib-row-dialog__lead">{copy.addDescription}</p>
        <Select
          id="model-row-provider"
          label={copy.provider}
          options={providers.map((name) => ({
            value: name,
            label: providerDisplayName(name),
          }))}
          value={provider}
          onchange={(event) => {
            provider = event.currentTarget.value;
            chooseBase(rows.find((row) => row.provider === provider && !row.added));
          }}
        />
        <Input
          id="model-row-name"
          label={copy.model}
          description={copy.modelDescription}
          variant="code"
          bind:value={model}
          error={errors['model'] ?? ''}
        />
        <Select
          id="model-row-based-on"
          label={copy.basedOn}
          description={copy.basedOnDescription}
          options={baseChoices.map((name) => ({ value: name, label: name }))}
          value={basedOn}
          error={errors['basedOn'] ?? ''}
          onchange={(event) =>
            chooseBase(
              rows.find(
                (row) => row.provider === provider && row.model === event.currentTarget.value,
              ),
            )}
        />
      {/if}
      <NumberInput
        id="model-row-context"
        label={copy.contextWindow}
        value={contextWindowTokens}
        error={errors['context'] ?? ''}
        onValueChange={(next) => (contextWindowTokens = next)}
      />
      <NumberInput
        id="model-row-output"
        label={copy.maxOutput}
        value={maxOutputTokens}
        error={errors['output'] ?? ''}
        onValueChange={(next) => (maxOutputTokens = next)}
      />
      <NumberInput
        id="model-row-input-price"
        label={copy.inputPrice}
        value={inputPrice}
        error={errors['input'] ?? ''}
        onValueChange={(next) => (inputPrice = next)}
      />
      <NumberInput
        id="model-row-output-price"
        label={copy.outputPrice}
        value={outputPrice}
        error={errors['outputPrice'] ?? ''}
        onValueChange={(next) => (outputPrice = next)}
      />
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close}>{copy.cancel}</Button>
    <Button variant="primary" onclick={apply}>{adding ? copy.add : copy.apply}</Button>
  {/snippet}
</Modal>

<style>
  .ib-row-dialog {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-row-dialog__lead {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
