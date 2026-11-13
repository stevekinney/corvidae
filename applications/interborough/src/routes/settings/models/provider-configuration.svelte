<script lang="ts">
  /**
   * A provider's plugin configuration inside the Connect and Manage dialogs (COR-2148): the fields
   * the plugin's own schema describes (a `baseURL`, say), drawn by `contributed-configuration-form`
   * straight into the dialog body with no box of their own, and the words for a save that failed
   * and named no field. A value the host refuses is shown at its field. A provider whose plugin takes
   * no settings shows nothing, and one whose schema cannot be drawn says so by name. The draft and
   * the save live in `provider-configuration.svelte.ts`; the dialog's own button saves it.
   */
  import { Callout, SectionHeading } from '@lostgradient/cinder';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import ContributedConfigurationForm from '../../../lib/contributed-configuration-form.svelte';
  import type { ProviderConfigurationDraft } from './provider-configuration.svelte.ts';

  interface Props {
    configuration: ProviderConfigurationDraft;
    /** Whether a heading names the settings, which a dialog that also holds the key field wants. */
    heading?: boolean;
  }

  let { configuration, heading = false }: Props = $props();

  const copy = MODELS_COPY.configuration;
  const source = $derived(configuration.source);
</script>

{#if source !== undefined && configuration.undrawable}
  <p class="ib-provider-configuration__note" data-testid="provider-configuration-unavailable">
    {copy.unavailable(source.title)}
  </p>
{:else if source !== undefined && configuration.hasFields}
  <section class="ib-provider-configuration" data-testid="provider-configuration">
    {#if heading}
      <SectionHeading level={4} title={copy.heading} />
    {/if}
    <ContributedConfigurationForm
      kindId={configuration.kindId}
      schema={source.schema}
      value={configuration.stored}
      issues={configuration.issues}
      onChange={(next) => configuration.change(next)}
    />
    {#if configuration.failure !== ''}
      <Callout variant="danger" data-testid="provider-configuration-failed">
        <p class="ib-provider-configuration__failure">{configuration.failure}</p>
      </Callout>
    {/if}
  </section>
{/if}

<style>
  .ib-provider-configuration {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-provider-configuration__note {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-provider-configuration__failure {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
