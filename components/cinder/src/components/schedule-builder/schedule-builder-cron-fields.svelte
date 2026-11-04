<script lang="ts">
  import { CircleAlert } from '../icons/index.ts';
  import Input from '../input/input.svelte';
  import { CRON_FIELDS, describeCronFieldError } from './schedule-builder.utilities.ts';

  let {
    baseId,
    cronFields,
    onFieldChange,
  }: {
    baseId: string;
    cronFields: string[];
    onFieldChange: (index: number, value: string) => void;
  } = $props();

  const errors = $derived(
    CRON_FIELDS.map((_, index) => describeCronFieldError(cronFields[index] ?? '', index)),
  );
  // One message at a time, for the first field that needs fixing; every field that does is marked.
  const firstError = $derived(errors.find((message) => message !== undefined));
  const errorId = $derived(`${baseId}-cron-error`);
</script>

<div class="cinder-schedule-builder__cron">
  <div class="cinder-schedule-builder__cron-fields">
    {#each CRON_FIELDS as field, index (field.name)}
      <Input
        id={`${baseId}-cron-field-${index}`}
        label={field.name}
        description={field.hint}
        value={cronFields[index] ?? ''}
        variant="code"
        spellcheck={false}
        autocomplete="off"
        aria-invalid={errors[index] === undefined ? undefined : 'true'}
        aria-describedby={errors[index] === undefined ? undefined : errorId}
        oninput={(event) => onFieldChange(index, (event.currentTarget as HTMLInputElement).value)}
      />
    {/each}
  </div>
  <p
    id={errorId}
    class="cinder-form-field__error cinder-schedule-builder__cron-error"
    aria-live="polite"
    data-cinder-error={firstError ? '' : undefined}
  >
    {#if firstError}
      <CircleAlert size={14} aria-hidden="true" class="cinder-form-field__glyph" />
      <span class="cinder-form-field__error-text">{firstError}</span>
    {/if}
  </p>
</div>
