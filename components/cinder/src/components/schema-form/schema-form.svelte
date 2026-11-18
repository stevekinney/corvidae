<script lang="ts" module>
  export type {
    SchemaFormDraftChangeHandler,
    SchemaFormOutput,
    SchemaFormProps,
    SchemaFormSchema,
    SchemaFormSecretCopy,
    SchemaFormSecretKey,
    SchemaFormSecrets,
    SchemaFormSubmitHandler,
    SchemaFormVariant,
  } from './schema-form.types.ts';
</script>

<script lang="ts">
  import type { SchemaFormProps } from './schema-form.types.ts';
  import SchemaFormBody from './schema-form-body.svelte';

  /**
   * Schema-driven form that renders accessible controls from JSON Schema and
   * submits one validated value object.
   *
   * **Schema changes reset form state.** When the `schema` prop changes, the
   * internal form body is remounted and all mutable state (formValue, errors,
   * rawDrafts, arrayKeys) is reset to values seeded from the new schema and the
   * current `value` prop.
   *
   * **`value` is a seed, not a live binding.** The consumer owns the form state
   * after mount. Changing `value` with the same schema does NOT reset formValue —
   * only a schema change triggers a remount and state reset. This is intentional:
   * the form is an editing surface, and resetting it on every external value change
   * would discard in-progress user edits.
   *
   * Use `onDraftChange` to observe the complete live draft without turning
   * `value` into a controlled binding. Draft callbacks run before schema
   * validation, while `onSubmit` runs only after validation passes.
   */
  let { schema, ...rest }: SchemaFormProps = $props();
</script>

<!--
  {#key schema} destroys and recreates SchemaFormBody whenever schema changes.
  Because all mutable form state ($state variables) lives inside SchemaFormBody's
  script, the key-block remount causes genuine $state recreation — not just DOM
  reconciliation. This is the idiomatic Svelte 5 fix for "reset component state
  on prop change" without a write-back $effect.
-->
{#key schema}
  <SchemaFormBody {schema} {...rest} />
{/key}
