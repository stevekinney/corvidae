<script lang="ts" module>
  export type { FormFieldManaged, FormFieldProps } from './form-field.types.ts';
</script>

<script lang="ts">
  import type { FormFieldProps } from './form-field.types.ts';
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    id,
    label,
    labelVisible = true,
    description,
    descriptionAction,
    warning,
    warningAction,
    error,
    errorGlyph,
    errorAction,
    note,
    trailing,
    managed,
    required = false,
    disabled = false,
    class: className,
    children,
  }: FormFieldProps = $props();
</script>

<FormFieldFrame
  {id}
  {label}
  {labelVisible}
  {description}
  {descriptionAction}
  {warning}
  {warningAction}
  {error}
  {errorGlyph}
  {errorAction}
  {note}
  {managed}
  {required}
  {disabled}
  class={classNames(className)}
  controlClass={trailing ? 'cinder-form-field__control--row' : undefined}
  after={trailing}
  control={children}
/>
