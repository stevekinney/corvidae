<!--
  Internal component: a SchemaForm in `readOnly` mode. Every field is a label and its value, never a
  control, and a field that must not be shown is not: a secret field is its key and a Set or Missing
  dot, and a `writeOnly` field is only "Hidden". Not part of the public API.
-->
<script lang="ts">
  import { describeDuration } from '../duration-field/duration-units.ts';
  import StatusDot from '../status-dot/status-dot.svelte';
  import {
    choiceBranchForValue,
    isConcealedSchema,
    isRecord,
    secretKeyOf,
    type SchemaFormField,
  } from './schema-form-model.ts';
  import { resolveSecretCopy } from './schema-form-secret.ts';
  import type { SchemaFormSecrets } from './schema-form.types.ts';

  interface Props {
    /** The root field of the form's model. */
    field: SchemaFormField;
    /** The value to show. */
    value: unknown;
    secrets: SchemaFormSecrets | undefined;
  }

  let { field, value, secrets }: Props = $props();

  const copy = $derived(resolveSecretCopy(secrets?.copy));

  /** What an empty value reads as. */
  const EMPTY = '—';

  function member(current: unknown, key: string): unknown {
    return isRecord(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  }

  /** Whether the key is saved: what the host lists, and Missing for a key it does not list. */
  function isSet(key: string): boolean {
    return secrets?.keys.find((entry) => entry.key === key)?.set === true;
  }

  function plainText(target: SchemaFormField, current: unknown): string {
    if (current === undefined || current === null || current === '') return EMPTY;
    if (target.kind === 'boolean') return current === true ? copy.yes : copy.no;
    if (target.kind === 'enum') {
      return target.options.find((option) => option.value === current)?.label ?? String(current);
    }
    if ((target.kind === 'number' || target.kind === 'integer') && target.unit === 'milliseconds') {
      return typeof current === 'number' ? describeDuration(current) : String(current);
    }
    if (target.kind === 'tags' || target.kind === 'enumArray') {
      if (!Array.isArray(current) || current.length === 0) return EMPTY;
      const labels = new Map(target.options.map((option) => [option.value, option.label]));
      return current.map((entry) => labels.get(entry as never) ?? String(entry)).join(', ');
    }
    if (
      typeof current === 'string' ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      return String(current);
    }
    return JSON.stringify(current);
  }
</script>

{#snippet entries(fields: readonly SchemaFormField[], current: unknown)}
  <dl class="cinder-schema-form__read-only">
    {#each fields as child (child.path.join('/'))}
      <div class="cinder-schema-form__read-only-entry">
        <dt>{child.label}</dt>
        <dd>{@render shown(child, member(current, child.key))}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

{#snippet shown(target: SchemaFormField, current: unknown)}
  {#if target.kind === 'secret'}
    {@const key = secretKeyOf(current)}
    {#if key === undefined}
      <span class="cinder-schema-form__read-only-empty">{copy.notChosen}</span>
    {:else}
      <code class="cinder-schema-form__secret-key" data-cinder-secret-key>{key}</code>
      <StatusDot
        word={isSet(key) ? 'Set' : 'Missing'}
        label={isSet(key) ? copy.set : copy.missingNote}
        size="sm"
      />
    {/if}
  {:else if isConcealedSchema(target.schema)}
    <span class="cinder-schema-form__read-only-empty">{copy.hidden}</span>
  {:else if target.kind === 'object'}
    {@render entries(target.fields, current)}
  {:else if target.kind === 'choice'}
    {@const branch = choiceBranchForValue(target, current)}
    {#if branch.kind === 'object'}
      {@render entries(branch.fields, current)}
    {:else}
      {@render shown(branch, current)}
    {/if}
  {:else if target.kind === 'array' && target.item !== undefined}
    {#if Array.isArray(current) && current.length > 0}
      <ol class="cinder-schema-form__read-only-list">
        {#each current as entry, index (index)}
          <li>{@render shown(target.item, entry)}</li>
        {/each}
      </ol>
    {:else}
      <span class="cinder-schema-form__read-only-empty">{EMPTY}</span>
    {/if}
  {:else if target.kind === 'record' && isRecord(current) && Object.keys(current).length > 0}
    <dl class="cinder-schema-form__read-only">
      {#each Object.entries(current) as [name, entry] (name)}
        <div class="cinder-schema-form__read-only-entry">
          <dt>{name}</dt>
          <dd>{typeof entry === 'string' ? entry : JSON.stringify(entry)}</dd>
        </div>
      {/each}
    </dl>
  {:else}
    {@const text = plainText(target, current)}
    {#if text === EMPTY}
      <span class="cinder-schema-form__read-only-empty">{EMPTY}</span>
    {:else}
      {text}
    {/if}
  {/if}
{/snippet}

{#if field.kind === 'object'}
  {@render entries(field.fields, value)}
{:else}
  {@render shown(field, value)}
{/if}
