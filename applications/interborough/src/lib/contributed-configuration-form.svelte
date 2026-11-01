<script lang="ts">
  /**
   * The fields of a contributed kind's configuration (a plugin's trigger kind or hook action kind),
   * drawn by Cinder's `SchemaForm` from the JSON Schema the Bureau reports (`bureau.plugins.kinds`).
   * The form takes its value once, so it is made again whenever the kind changes (`kindId`), and
   * reports every committed draft: a number still being typed is not reported until it is a number.
   * A kind whose schema has no fields says so, and one the form cannot draw says that.
   */
  import { SchemaForm } from '@lostgradient/cinder';

  import { PLUGIN_KINDS_COPY } from '../app/copy.ts';
  import { formSchemaOf, numbersCommitted } from '../routes/settings/settings-form-schema.ts';

  interface Props {
    /** Names the kind, so the form starts over when the kind is another. */
    kindId: string;
    /** The kind's configuration schema, or `null` when it could not be written as one. */
    schema: Readonly<Record<string, unknown>> | null;
    /** The configuration the form starts with. */
    value?: unknown;
    /** Takes the configuration after each edit. */
    onChange: (value: Record<string, unknown>) => void;
  }

  let { kindId, schema, value, onChange }: Props = $props();

  /** The schema as the form reads it, without the dialect marker Zod writes. */
  const formSchema = $derived.by(() => {
    if (schema === null) return undefined;
    const { $schema: _dialect, ...rest } = schema;
    return formSchemaOf(kindId, rest);
  });

  const hasFields = $derived.by(() => {
    const properties = formSchema?.['properties'];
    return (
      typeof properties === 'object' && properties !== null && Object.keys(properties).length > 0
    );
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
