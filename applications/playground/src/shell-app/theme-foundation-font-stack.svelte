<script lang="ts">
  /*
   * The font stack editor (COR-489): an ordered list of families with Move up, Move down and
   * Remove on every row, so reordering never needs a pointer. Only fonts the browser already
   * has are drawn and nothing is fetched or uploaded; a named family this browser cannot find
   * is flagged "environment-dependent" in the editor, and `environmentDependentFamilies` is the
   * same hook the export and report surfaces use.
   */
  import { Button, Input } from '@lostgradient/cinder';
  import { tick } from 'svelte';

  import {
    browserFontProbe,
    ENVIRONMENT_DEPENDENT_NOTICE,
    isGenericFamily,
    type FontProbe,
  } from './theme-font-availability.ts';
  import {
    MAX_FAMILIES,
    type FieldErrors,
    type FoundationFields,
  } from './theme-foundation-values.ts';

  type Stack = Extract<FoundationFields, { kind: 'fontFamily' }>;

  type Props = {
    fields: Stack;
    errors: FieldErrors;
    idBase: string;
    label: (part: string) => string;
    disabled: boolean;
    onchange: (next: Stack) => void;
    announce: (message: string) => void;
    onenter: () => void;
    probe?: FontProbe;
  };
  let {
    fields,
    errors,
    idBase,
    label,
    disabled,
    onchange,
    announce,
    onenter,
    probe = browserFontProbe(),
  }: Props = $props();

  let adding = $state('');

  const availability = $derived(
    fields.families.map(
      (family) => isGenericFamily(family) || family.trim() === '' || probe(family),
    ),
  );

  function set(families: string[]): void {
    onchange({ ...fields, families });
  }

  async function move(index: number, by: -1 | 1): Promise<void> {
    const target = index + by;
    if (target < 0 || target >= fields.families.length) return;
    const families = [...fields.families];
    const [moved] = families.splice(index, 1);
    families.splice(target, 0, moved!);
    set(families);
    announce(`Moved ${moved} to position ${target + 1} of ${families.length}`);
    await tick();
    const preferred = document.getElementById(`${idBase}-${by === -1 ? 'up' : 'down'}-${target}`);
    const button = preferred instanceof HTMLButtonElement && !preferred.disabled ? preferred : null;
    (button ?? document.getElementById(`${idBase}-family-${target}`))?.focus();
  }

  async function remove(index: number): Promise<void> {
    const removed = fields.families[index];
    set(fields.families.filter((_, position) => position !== index));
    announce(`Removed ${removed ?? 'family'}`);
    await tick();
    document.getElementById(`${idBase}-add`)?.focus();
  }

  function add(): void {
    const name = adding.trim();
    if (name === '' || fields.families.length >= MAX_FAMILIES) return;
    set([...fields.families, name]);
    announce(`Added ${name} at the end of the stack`);
    adding = '';
  }

  function keydown(event: KeyboardEvent, action: () => void): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      action();
    }
  }
</script>

<div class="stack" role="group" aria-label={label('font stack')}>
  <ol class="stack__list">
    {#each fields.families as family, index (index)}
      {@const position = `${index + 1} of ${fields.families.length}`}
      <li class="stack__row">
        <div class="stack__name" onkeydown={(event) => keydown(event, onenter)} role="presentation">
          <Input
            id={`${idBase}-family-${index}`}
            label={`${label('family')} ${position}`}
            autocomplete="off"
            spellcheck={false}
            {disabled}
            value={family}
            {...errors[`family-${index}`] === undefined ? {} : { error: errors[`family-${index}`] }}
            onValueChange={(next) =>
              set(fields.families.map((entry, at) => (at === index ? next : entry)))}
          />
        </div>
        <div class="stack__actions" role="group" aria-label={`${family || 'Family'}, ${position}`}>
          <Button
            id={`${idBase}-up-${index}`}
            label="Move up"
            aria-label={`Move ${family || 'family'} up`}
            variant="secondary"
            size="sm"
            disabled={disabled || index === 0}
            onclick={() => void move(index, -1)}
          />
          <Button
            id={`${idBase}-down-${index}`}
            label="Move down"
            aria-label={`Move ${family || 'family'} down`}
            variant="secondary"
            size="sm"
            disabled={disabled || index === fields.families.length - 1}
            onclick={() => void move(index, 1)}
          />
          <Button
            label="Remove"
            aria-label={`Remove ${family || 'family'}`}
            variant="ghost-danger"
            size="sm"
            {disabled}
            onclick={() => void remove(index)}
          />
        </div>
        {#if availability[index] === false}
          <p class="stack__notice" data-testid="environment-dependent">
            <strong>{family}</strong>: {ENVIRONMENT_DEPENDENT_NOTICE}
          </p>
        {/if}
      </li>
    {/each}
  </ol>
  <div class="stack__add" onkeydown={(event) => keydown(event, add)} role="presentation">
    <Input
      id={`${idBase}-add`}
      label={label('new family')}
      description="Added at the end of the stack. Generic names such as sans-serif are always available."
      autocomplete="off"
      spellcheck={false}
      {disabled}
      value={adding}
      {...errors['families'] === undefined ? {} : { error: errors['families'] }}
      onValueChange={(next) => (adding = next)}
    />
    <Button label="Add family" variant="secondary" {disabled} onclick={add} />
  </div>
</div>

<style>
  .stack,
  .stack__list {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stack__row {
    display: grid;
    gap: 4px;
    padding: 8px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }
  .stack__actions,
  .stack__add {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
  }
  .stack__name {
    min-width: 0;
  }
  .stack__notice {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
