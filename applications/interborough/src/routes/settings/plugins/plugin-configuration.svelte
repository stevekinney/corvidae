<script lang="ts">
  /**
   * A plugin's configuration as a form (board PageSettingsSections, "Plugins · /settings/plugins"):
   * one Settings row per field of the plugin's own schema, each with the control its shape calls for
   * (text, select, tags, switch, number, a number with a unit), and one explicit Save. Saving stores
   * the configuration through `PUT /host/plugins/<name>` and restarts nothing: the change waits for
   * a restart, which the page's restart notice counts, so the note beside the button says so.
   *
   * The values stay as typed when a save fails. A field the host refuses shows the host's words at
   * that field; a failure that names no field (the host did not answer) shows under the button, and
   * Save is the retry.
   */
  import {
    Alert,
    Button,
    DurationField,
    FormSection,
    Input,
    JsonEditor,
    NumberInput,
    SectionHeading,
    Select,
    SettingRow,
    TagInput,
    Toggle,
  } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { RotateCw } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import { HostPluginError, updatePlugin, type PluginStanding } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import {
    configurationFields,
    configurationToSave,
    jsonText,
    parseJsonField,
    refusedField,
  } from './plugin-configuration.ts';

  interface Props {
    plugin: PluginStanding;
    /** Whether the host keeps its plugin choices in its deployment, so nothing can be saved. */
    locked: boolean;
  }

  let { plugin, locked }: Props = $props();

  const copy = PLUGINS_COPY.configuration;
  const queryClient = useQueryClient();
  const fields = $derived(configurationFields(plugin.configurationSchema));
  const name = $derived(plugin.descriptor.name);

  function storedOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
  }

  // The values the form holds: what the host stores, then what the person typed. The form is made
  // again when the stored configuration changes under it (`plugin-detail.svelte` keys it), so these
  // are read once.
  let draft = $state<Record<string, unknown>>(untrack(() => storedOf(plugin.configuration)));
  /** The text of a field edited as JSON, which may not parse yet. */
  let jsonTexts = $state<Record<string, string>>({});
  let fieldErrors = $state<Record<string, string>>({});
  let failure = $state('');
  let saving = $state(false);

  /** What a field shows: what the form holds, else the value the plugin uses when it holds none. */
  const valueOf = (key: string, fallback: unknown): unknown =>
    Object.hasOwn(draft, key) ? draft[key] : fallback;

  function change(key: string, next: unknown): void {
    draft[key] = next;
    delete fieldErrors[key];
    failure = '';
  }

  function changeJson(key: string, text: string): void {
    jsonTexts[key] = text;
    const parsed = parseJsonField(text);
    if (parsed === 'invalid') {
      fieldErrors[key] = copy.invalidJson;
      return;
    }
    change(key, parsed.value);
  }

  const idOf = (key: string): string => `plugin-configuration-${name}-${key}`;

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving || locked || Object.keys(fieldErrors).length > 0) return;
    saving = true;
    failure = '';
    fieldErrors = {};
    try {
      const stored = await updatePlugin(name, { configuration: configurationToSave(draft) });
      showToast(stored.restartRequired ? copy.saved : copy.savedNow, { variant: 'success' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    } catch (error) {
      if (error instanceof HostPluginError && error.kind === 'invalid') {
        const key = refusedField(error.field);
        if (key !== undefined && fields.some((field) => field.key === key)) {
          fieldErrors = { [key]: copy.rejected(error.message) };
          return;
        }
        failure = copy.rejected(error.message);
      } else if (error instanceof HostPluginError && error.kind === 'locked') {
        failure = copy.locked;
      } else {
        failure = copy.failed;
      }
    } finally {
      saving = false;
    }
  }
</script>

{#if fields.length > 0}
  <section class="ib-plugin-configuration" data-testid="plugin-configuration">
    <SectionHeading
      level={4}
      title={PLUGINS_COPY.sections.configuration}
      description={copy.description}
    />
    <form onsubmit={(event) => void save(event)} novalidate>
      <FormSection grouped>
        {#each fields as field (field.key)}
          {@const id = idOf(field.key)}
          {@const value = valueOf(field.key, field.defaultValue)}
          <div data-configuration-field={field.key}>
            <SettingRow
              {id}
              label={field.label}
              identifier={field.key}
              description={field.description}
              required={field.required}
              disabled={locked}
              {...fieldErrors[field.key] === undefined ? {} : { error: fieldErrors[field.key] }}
              controlWidth={field.control.kind === 'switch' ? 'auto' : '16rem'}
            >
              {#snippet control()}
                {#if field.control.kind === 'text'}
                  <Input
                    {id}
                    label={field.label}
                    variant="code"
                    value={typeof value === 'string' ? value : ''}
                    disabled={locked}
                    onValueChange={(next) => change(field.key, next)}
                  />
                {:else if field.control.kind === 'select'}
                  <Select
                    {id}
                    label={field.label}
                    labelVisible={false}
                    options={[
                      ...(field.required || field.defaultValue !== undefined
                        ? []
                        : [{ value: '', label: copy.notSet }]),
                      ...field.control.options.map((option) => ({ value: option, label: option })),
                    ]}
                    value={typeof value === 'string' ? value : ''}
                    disabled={locked}
                    onchange={(event) => change(field.key, event.currentTarget.value || undefined)}
                  />
                {:else if field.control.kind === 'switch'}
                  <Toggle
                    {id}
                    label={field.label}
                    checked={value === true}
                    disabled={locked}
                    onValueChange={(next) => change(field.key, next)}
                  />
                {:else if field.control.kind === 'duration'}
                  <DurationField
                    {id}
                    value={typeof value === 'number' ? value : null}
                    disabled={locked}
                    onValueChange={(next) => change(field.key, next ?? undefined)}
                  />
                {:else if field.control.kind === 'number'}
                  <NumberInput
                    {id}
                    value={typeof value === 'number' ? value : null}
                    disabled={locked}
                    onValueChange={(next) => change(field.key, next ?? undefined)}
                  />
                {:else if field.control.kind === 'tags'}
                  <TagInput
                    value={Array.isArray(value) ? value.map(String) : []}
                    placeholder={copy.addTag}
                    commitOnSubmit
                    disabled={locked}
                    onValueChange={(next) =>
                      change(field.key, next.length === 0 ? undefined : next)}
                  />
                {/if}
              {/snippet}
              {#snippet disclosure()}
                {#if field.control.kind === 'json'}
                  <JsonEditor
                    {id}
                    label={copy.json(field.label)}
                    rows={5}
                    validFeedbackVisible={false}
                    disabled={locked}
                    value={jsonTexts[field.key] ?? jsonText(value)}
                    error={fieldErrors[field.key] ?? ''}
                    onValueChange={(next) => changeJson(field.key, next)}
                  />
                {/if}
              {/snippet}
            </SettingRow>
          </div>
        {/each}
      </FormSection>
      <div class="ib-plugin-configuration__footer">
        <Button type="submit" variant="primary" disabled={locked || saving}>
          {saving ? copy.saving : copy.save}
        </Button>
        <span class="ib-plugin-configuration__note">
          <RotateCw size={14} aria-hidden="true" />
          {copy.note}
        </span>
      </div>
      {#if failure !== ''}
        <Alert variant="danger" data-testid="plugin-configuration-failed">
          <p class="ib-plugin-configuration__failure">
            <strong>{copy.failureLead}</strong>
            {failure}
          </p>
        </Alert>
      {/if}
    </form>
  </section>
{/if}

<style>
  .ib-plugin-configuration {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-plugin-configuration form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-plugin-configuration__footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-plugin-configuration__note {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-plugin-configuration__failure {
    margin: 0;
  }
</style>
