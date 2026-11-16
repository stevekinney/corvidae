<script lang="ts">
  /**
   * The fields of a contributed kind's configuration (a plugin's trigger kind or hook action kind),
   * drawn by Cinder's `SchemaForm` from the JSON Schema the Bureau reports (`bureau.plugins.contributions`).
   * The form takes its value once, so it is made again whenever the kind changes (`kindId`), and
   * reports every committed draft: a number still being typed is not reported until it is a number.
   * The form reports nothing before the first edit, so the draft it shows at mount (a choice's first
   * option, a switch off) is reported once as well, and an untouched form saves what it displays.
   * A kind whose schema has no fields says so, and one the form cannot draw says that. The form
   * draws no Submit button: the page's own action saves what the form reports.
   */
  import { SchemaForm, schemaFormInitialDraft, type SchemaFormVariant } from '@lostgradient/cinder';
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
    /**
     * Whether the form sits inside another form or a card, as a workflow's trigger and a step's
     * input do: it is then a group, not a `<form>` of its own, and its groups draw no borders.
     */
    hosted?: boolean;
    /**
     * Whether the draft the form shows at mount is reported once, so an untouched form saves what
     * it displays. A step's input turns it off: a step is given its starting input when it is
     * added, and opening a file is not an edit.
     */
    reportInitialDraft?: boolean;
    /**
     * How the fields are drawn (`SchemaForm`'s `variant`). A page that shows a plugin's configuration
     * as settings passes `setting-rows`; the hook editor and the workflow builder pass nothing and
     * keep the stacked fields.
     */
    variant?: SchemaFormVariant;
    /** Called when a number is being typed and is not yet one, so no draft is reported for it. */
    onPending?: () => void;
    /** Whether every control is disabled, as a page does for a configuration its deployment holds. */
    disabled?: boolean;
    /** What it says when the schema takes no fields, and when the form cannot draw it. Default to the plugin words. */
    noFieldsText?: string;
    unavailableText?: string;
  }

  let {
    kindId,
    schema,
    value,
    onChange,
    hosted = false,
    reportInitialDraft = true,
    variant = 'default',
    disabled = false,
    onPending,
    noFieldsText = PLUGIN_KINDS_COPY.noFields,
    unavailableText = PLUGIN_KINDS_COPY.fieldsUnavailable,
    issues,
  }: Props = $props();

  // The schema the form is drawn from keeps its identity while its content is the same: the form
  // starts over when it is given another schema, so a read of the plugins that hands back an equal
  // schema in a new object would otherwise throw away what a person has typed and not yet saved.
  let drawn: Record<string, unknown> | undefined;
  const formSchema = $derived.by(() => {
    const next = contributedFormSchema(kindId, schema);
    if (drawn !== undefined && next !== undefined && isSameJson(drawn, next)) return drawn;
    drawn = next;
    return next;
  });
  const hasFields = $derived(contributedFormHasFields(formSchema));

  // The form emits no draft until an edit, so the one it shows at mount is reported here, once per
  // schema. `value` is read untracked: the report changes it, and must not run this again.
  $effect(() => {
    if (!reportInitialDraft || formSchema === undefined || !hasFields) return;
    const shown = schemaFormInitialDraft(
      formSchema,
      untrack(() => value),
      variant,
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
    if (formSchema === undefined) return;
    if (!numbersCommitted(formSchema, next)) {
      // A number still being typed is an edit that has not finished: it is not reported, but a
      // page that holds a Save button needs to know the form is no longer as it was.
      onPending?.();
      return;
    }
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      onChange(next as Record<string, unknown>);
    }
  }
</script>

<div class="ib-contributed-configuration" data-testid="contributed-configuration">
  {#if formSchema === undefined}
    <p class="ib-contributed-configuration__note">{unavailableText}</p>
  {:else if !hasFields}
    <p class="ib-contributed-configuration__note">{noFieldsText}</p>
  {:else}
    {#key kindId}
      <SchemaForm
        schema={formSchema}
        name={`configuration-${kindId}`}
        {value}
        jsonEditable={false}
        submitVisible={false}
        {hosted}
        {variant}
        {disabled}
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
