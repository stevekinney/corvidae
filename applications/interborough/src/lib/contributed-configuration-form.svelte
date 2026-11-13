<script lang="ts">
  /**
   * The fields of a contributed kind's configuration (a plugin's trigger kind or hook action kind),
   * drawn by Cinder's `SchemaForm` from the JSON Schema the Bureau reports (`bureau.plugins.contributions`).
   * The form takes its value once, so it is made again whenever the kind changes (`kindId`), and
   * reports every committed draft: a number still being typed is not reported until it is a number.
   * The form reports nothing before the first edit, so the draft it shows at mount (a choice's first
   * option, a switch off) is reported once as well, and an untouched form saves what it displays.
   * A kind whose schema has no fields says so, and one the form cannot draw says that.
   */
  import { SchemaForm, schemaFormInitialDraft } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { PLUGIN_KINDS_COPY } from '../app/copy/plugins.ts';
  import { numbersCommitted } from '../routes/settings/settings-form-schema.ts';
  import {
    contributedFormHasFields,
    contributedFormSchema,
    isSameJson,
  } from './contributed-configuration.ts';

  interface Props {
    /** Names the kind, so the form starts over when the kind is another. */
    kindId: string;
    /** The kind's configuration schema, or `null` when it could not be written as one. */
    schema: Readonly<Record<string, unknown>> | null;
    /** The configuration the form starts with. */
    value?: unknown;
    /** Takes the configuration after each edit. */
    onChange: (value: Record<string, unknown>) => void;
    /**
     * Problems the host found with a value this form saved, each shown on the field its `path`
     * names (`SchemaForm`'s `issues`), and cleared when that field is edited.
     */
    issues?: readonly { path: readonly (string | number)[]; message: string }[] | undefined;
  }

  let { kindId, schema, value, onChange, issues }: Props = $props();

  const formSchema = $derived(contributedFormSchema(kindId, schema));
  const hasFields = $derived(contributedFormHasFields(formSchema));

  // The form emits no draft until an edit, so the one it shows at mount is reported here, once per
  // schema. `value` is read untracked: the report changes it, and must not run this again.
  $effect(() => {
    if (formSchema === undefined || !hasFields) return;
    const shown = schemaFormInitialDraft(
      formSchema,
      untrack(() => value),
    );
    if (typeof shown !== 'object' || shown === null || Array.isArray(shown)) return;
    // A configuration that already holds what the form shows is left alone, so opening a file or a
    // hook is not an edit.
    if (
      isSameJson(
        shown,
        untrack(() => value),
      )
    )
      return;
    untrack(() => onChange(shown as Record<string, unknown>));
  });

  function draft(next: unknown): void {
    if (formSchema === undefined || !numbersCommitted(formSchema, next)) return;
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      onChange(next as Record<string, unknown>);
    }
  }
</script>

<div class="ib-contributed-configuration" data-testid="contributed-configuration">
  {#if formSchema === undefined}
    <p class="ib-contributed-configuration__note">{PLUGIN_KINDS_COPY.fieldsUnavailable}</p>
  {:else if !hasFields}
    <p class="ib-contributed-configuration__note">{PLUGIN_KINDS_COPY.noFields}</p>
  {:else}
    {#key kindId}
      <SchemaForm
        schema={formSchema}
        name={`configuration-${kindId}`}
        {value}
        jsonEditable={false}
        submitVisible={false}
        {issues}
        onDraftChange={draft}
      />
    {/key}
  {/if}
</div>

<style>
  .ib-contributed-configuration {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-contributed-configuration__note {
    margin: 0;
    color: var(--cinder-text-muted);
  }
</style>
