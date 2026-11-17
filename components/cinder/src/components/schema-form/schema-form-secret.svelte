<!--
  Internal component: the control of a SchemaForm field marked `secret: true`. It is a Select of the
  saved secret keys the host names (`secrets.keys`), grouped by their `group`, each with a "Set" or
  "Missing" note. It holds a key and nothing else: no text or password input is drawn for it, so a
  value can neither be shown nor typed. Not part of the public API.
-->
<script lang="ts">
  import Button from '../button/button.svelte';
  import Link from '../link/link.svelte';
  import Select from '../select/select.svelte';
  import type { SelectOption } from '../select/select.types.ts';
  import { resolveSecretCopy, secretOptionLabel, splitAroundKey } from './schema-form-secret.ts';
  import type { SchemaFormSecrets } from './schema-form.types.ts';

  interface Props {
    id: string;
    label: string;
    /** The field's own description, shown with the help. */
    description?: string | undefined;
    error?: string | undefined;
    required: boolean;
    disabled: boolean;
    /** The key the field names, or `undefined` when it names none. */
    value: string | undefined;
    secrets: SchemaFormSecrets | undefined;
    onValueChange: (key: string | undefined) => void;
    onblur?: () => void;
  }

  let {
    id,
    label,
    description,
    error,
    required,
    disabled,
    value,
    secrets,
    onValueChange,
    onblur,
  }: Props = $props();

  const copy = $derived(resolveSecretCopy(secrets?.copy));
  const keys = $derived(secrets?.keys ?? []);
  const failed = $derived(secrets?.status === 'failed');
  /** The chosen key's row, or a stand-in for a key the host does not list (so it is shown, as Missing). */
  const chosen = $derived(
    value === undefined
      ? undefined
      : (keys.find((entry) => entry.key === value) ?? { key: value, set: false }),
  );
  const rows = $derived(
    chosen !== undefined && !keys.some((entry) => entry.key === chosen.key)
      ? [...keys, chosen]
      : keys,
  );

  const NONE = '';
  const options = $derived<SelectOption[]>([
    ...(required ? [] : [{ value: NONE, label: copy.none }]),
    ...rows.map((entry) => {
      const shown = secretOptionLabel(entry.key);
      return {
        value: entry.key,
        label: shown,
        // A key that is cut shows whole on its own line: an option carries no tooltip.
        ...(shown === entry.key ? {} : { description: entry.key }),
        note: entry.set ? copy.set : copy.missingNote,
        ...(entry.group === undefined ? {} : { group: entry.group }),
      };
    }),
  ]);
  const help = $derived(
    [description, copy.help].filter((part) => part !== undefined && part !== '').join(' '),
  );
  const empty = $derived(rows.length === 0);
  const missing = $derived(chosen !== undefined && !chosen.set);
</script>

<div
  class="cinder-schema-form__secret"
  data-cinder-secret-state={failed ? 'failed' : empty ? 'empty' : 'ready'}
>
  {#if failed}
    <p class="cinder-schema-form__secret-label">{label}</p>
    <p class="cinder-schema-form__secret-failed" role="alert">
      {copy.failed}
      {#if secrets?.onRetry !== undefined}
        <Button variant="ghost" size="sm" onclick={() => secrets?.onRetry?.()}>{copy.retry}</Button>
      {/if}
    </p>
  {:else}
    <Select
      {id}
      {label}
      {required}
      presentation="listbox"
      class="cinder-schema-form__secret-select"
      disabled={disabled || empty}
      options={empty ? [] : options}
      placeholder={empty ? copy.emptyPlaceholder : copy.placeholder}
      {...empty ? {} : { description: help }}
      {...onblur === undefined ? {} : { onblur }}
      {...error === undefined ? {} : { error }}
      {...(value ?? (required ? undefined : NONE)) === undefined ? {} : { value: value ?? NONE }}
      onValueChange={(next) => onValueChange(next === NONE ? undefined : next)}
    />
    {#if empty}
      <p class="cinder-schema-form__secret-help">
        {copy.emptyHelp}
        {#if secrets?.manage !== undefined}
          <Link underline="always" href={secrets.manage.href} onclick={secrets.manage.onclick}
            >{secrets.manage.label}</Link
          >{copy.emptyHelpEnd}
        {/if}
      </p>
    {/if}
    {#if missing && chosen !== undefined}
      {@const sentence = copy.missing(chosen.key)}
      {@const parts = splitAroundKey(sentence, chosen.key)}
      <p class="cinder-schema-form__secret-warning" role="status">
        {#if parts === undefined}
          {sentence}
        {:else}
          {parts.before}<code class="cinder-schema-form__secret-key">{chosen.key}</code
          >{parts.after}
        {/if}
        {#if secrets?.onAdd !== undefined}
          <Button variant="ghost" size="sm" {disabled} onclick={() => secrets?.onAdd?.(chosen.key)}
            >{copy.addKey}</Button
          >
        {/if}
      </p>
    {/if}
  {/if}
</div>
