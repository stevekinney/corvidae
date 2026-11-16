<script lang="ts">
  /**
   * A plugin's configuration as a form (board PageSettingsSections, "Plugins, /settings/plugins"):
   * one Settings row per field of the plugin's own schema, drawn by Cinder's `SchemaForm` in its
   * `setting-rows` variant with the control each field's shape calls for (text, select, tags,
   * switch, number, a number with a unit), and one explicit Save. Saving stores the configuration
   * through `PUT /host/plugins/<name>` and restarts nothing: the change waits for a restart, which
   * the page's restart notice counts, so the note beside the button says so.
   *
   * Save is on only while the form holds a change. The values stay as typed when a save fails. A
   * field the host refuses shows the host's words at that row; a failure that names no field (the
   * host did not answer) shows under the button, and Save is the retry.
   */
  import { Alert, Button, SectionHeading, schemaFormInitialDraft } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';
  import { RotateCw } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import ContributedConfigurationForm from '../../../lib/contributed-configuration-form.svelte';
  import {
    contributedFormHasFields,
    contributedFormSchema,
  } from '../../../lib/contributed-configuration.ts';
  import { HostPluginError, updatePlugin, type PluginStanding } from '../../../lib/host-plugins.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import {
    configurationChanges,
    configurationToSave,
    hasConfigurationField,
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
  const name = $derived(plugin.descriptor.name);
  const formSchema = $derived(contributedFormSchema(name, plugin.configurationSchema));
  const hasFields = $derived(contributedFormHasFields(formSchema));

  function storedOf(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
  }

  // What the host stores, and what the form shows the moment it opens. The form is made again when
  // the stored configuration changes under it (`plugin-detail.svelte` keys it), so both are read once.
  const stored = untrack(() => storedOf(plugin.configuration));
  const initial = untrack(() => schemaFormInitialDraft(formSchema ?? {}, stored, 'setting-rows'));

  /** What the person changed from what the form opened with: all that Save sends over the stored values. */
  let changes = $state<Record<string, unknown>>({});
  let issues = $state<{ path: string[]; message: string }[] | undefined>();
  let failure = $state('');
  let saving = $state(false);

  /** A number is being typed and is not yet one: the form is no longer as it opened, though no draft is reported. */
  let pending = $state(false);

  const changed = $derived(pending || Object.keys(changes).length > 0);

  function reported(draft: Record<string, unknown>): void {
    pending = false;
    changes = configurationChanges(initial, draft);
    issues = undefined;
    failure = '';
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving || locked || !changed) return;
    saving = true;
    failure = '';
    issues = undefined;
    try {
      const sent = await updatePlugin(name, {
        configuration: configurationToSave({ ...stored, ...changes }),
      });
      showToast(sent.restartRequired ? copy.saved : copy.savedNow, { variant: 'success' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.hostPlugins() });
    } catch (error) {
      if (error instanceof HostPluginError && error.kind === 'invalid') {
        const key = refusedField(error.field);
        if (key !== undefined && hasConfigurationField(plugin.configurationSchema, key)) {
          issues = [{ path: [key], message: copy.rejected(error.message) }];
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

{#if hasFields}
  <section class="ib-plugin-configuration" data-testid="plugin-configuration">
    <SectionHeading
      level={4}
      title={PLUGINS_COPY.sections.configuration}
      description={copy.description}
    />
    <form onsubmit={(event) => void save(event)} novalidate>
      <ContributedConfigurationForm
        kindId={name}
        schema={plugin.configurationSchema}
        value={stored}
        variant="setting-rows"
        disabled={locked}
        hosted
        reportInitialDraft={false}
        {issues}
        onPending={() => (pending = true)}
        onChange={reported}
      />
      <div class="ib-plugin-configuration__footer">
        <Button type="submit" variant="primary" disabled={locked || saving || !changed}>
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
