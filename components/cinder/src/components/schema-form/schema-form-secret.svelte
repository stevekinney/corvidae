<!--
  Internal component: the control of a SchemaForm field marked `secret: true`. It is a Select of the
  saved secret keys the host names (`secrets.keys`), grouped by their `group`, each with a "Set" or
  "Missing" note. It holds a key and nothing else: no text or password input is drawn for it, so a
  value can neither be shown nor typed. Not part of the public API.
-->
<script lang="ts">
  import Button from '../button/button.svelte';
  import ErrorState from '../error-state/error-state.svelte';
  import Link from '../link/link.svelte';
  import Select from '../select/select.svelte';
  import type { SelectOption } from '../select/select.types.ts';
  import Text from '../text/text.svelte';
  import { resolveSecretCopy, splitAroundKey } from './schema-form-secret.ts';
  import type { SchemaFormSecrets } from './schema-form.types.ts';

  interface Props {
    id: string;
    label: string;
    /** Whether the label is drawn; a setting row draws its own, so its key choice keeps this one for assistive technology. */
    labelVisible?: boolean;
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
    labelVisible = true,
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
    // A key is an identifier: monospace, and a long one is cut in its middle with the whole key in
    // a tooltip, so its start (which plugin) and its end (which secret) both show.
    ...rows.map((entry) => ({
      value: entry.key,
      label: entry.key,
      code: true,
      note: entry.set ? copy.set : copy.missingNote,
      ...(entry.group === undefined ? {} : { group: entry.group }),
    })),
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
    <!-- The field's label as every other state draws it, required dot included. -->
    <p class="cinder-form-field__label cinder-schema-form__secret-label">
      {label}
      {#if required}
        <span class="cinder-_required-marker" aria-hidden="true"></span>
      {/if}
    </p>
    <!-- The keys failed to load: Cinder's one-row failure, its glyph, the words and its own retry. -->
    <ErrorState
      variant="row"
      class="cinder-schema-form__secret-failed"
      title={copy.failed}
      description=""
      headingLevel={3}
      retryLabel={copy.retry}
      retryVariant="secondary"
      {...secrets?.onRetry === undefined ? {} : { onRetry: () => secrets?.onRetry?.() }}
    />
  {:else}
    <Select
      {id}
      {label}
      {labelVisible}
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
          {parts.before}<Text
            variant="code"
            as="code"
            truncate="middle"
            text={chosen.key}
            class="cinder-schema-form__secret-key"
          />{parts.after}
        {/if}
        {#if secrets?.onAdd !== undefined}
          <!-- The sentence's one action: an underlined accent word, like the link in the empty state. -->
          <Button variant="link" {disabled} onclick={() => secrets?.onAdd?.(chosen.key)}
            >{copy.addKey}</Button
          >
        {/if}
      </p>
    {/if}
  {/if}
</div>
