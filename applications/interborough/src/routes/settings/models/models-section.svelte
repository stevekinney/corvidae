<script lang="ts">
  /**
   * The Models part of Settings › Models (board SettingsShell, "Models · /settings/models" and
   * "Models · provider connected"): every model the connected providers offer, as a table of
   * Model, Abilities, Context and Allowed. It only reads. Which models agents may use is set under
   * Allowed models, so the Allowed column says what that policy permits (a green dot and the word)
   * and the table has no switch, no edit and no Save.
   *
   * It is an operator table (board ListPatterns, "Option A, for operator tables only"): dense,
   * sortable by model and context, the identifier small and monospaced under the name. With no
   * provider connected it is an empty state that points up to Providers. When the list of models
   * fails to load after the key was saved, the error sits here and the provider row stays Connected.
   */
  import {
    EmptyState,
    ErrorState,
    FormSection,
    Link,
    StatusDot,
    Table,
    type TableSort,
  } from '@lostgradient/cinder';
  import { Cpu } from '@lucide/svelte';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import type { ProviderModel } from '../../../lib/host-providers.ts';
  import { deniedProvidersOf, isModelAllowed, type ModelPolicy } from '../model-policy-edit.ts';
  import { formatContext, formatModelAbilities, modelDisplayName } from './format-model.ts';
  import ModelName from './model-name.svelte';

  /** Why the list of models did not come back: the names of the providers that are connected, and the answer's status. */
  export interface CatalogFailure {
    readonly providers: readonly string[];
    readonly status: number | undefined;
  }

  interface Props {
    /** The models the connected providers offer. */
    models: readonly ProviderModel[];
    /** The model policy, which says which of them agents may use. */
    policy: ModelPolicy;
    /** Set when the list of models failed to load; the table is not drawn then. */
    failure?: CatalogFailure | undefined;
    /** Reads the list of models again. */
    onRetry: () => void;
    /** Takes the person to the Providers section, for the empty list. */
    onGoToProviders: () => void;
  }

  let { models, policy, failure, onRetry, onGoToProviders }: Props = $props();

  const copy = MODELS_COPY.models;
  const PROVIDERS_ANCHOR = '#ib-models-providers';

  let sort = $state<TableSort | undefined>(undefined);

  const denied = $derived(deniedProvidersOf(policy));
  const rows = $derived.by(() => {
    const listed = models.map((model) => ({
      model,
      name: modelDisplayName(model.model),
      allowed:
        !model.off && !denied.includes(model.provider) && isModelAllowed(policy, model.model),
    }));
    if (sort === undefined) return listed;
    const direction = sort.direction === 'ascending' ? 1 : -1;
    return listed.toSorted((a, b) =>
      sort?.column === 'context'
        ? direction * (a.model.contextWindowTokens - b.model.contextWindowTokens)
        : direction * a.name.localeCompare(b.name, 'en', { numeric: true }),
    );
  });

  function goToProviders(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onGoToProviders();
  }
</script>

<div class="ib-models" data-section="models">
  {#if failure === undefined && models.length > 0}
    <FormSection grouped heading={copy.heading} description={copy.description} />
    <Table caption={copy.tableLabel} density="comfortable" bind:sort>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell column="model" sortable>{copy.columns.model}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.abilities}</Table.HeaderCell>
          <Table.HeaderCell column="context" sortable>{copy.columns.context}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.allowed}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as row (`${row.model.provider}/${row.model.model}`)}
          <Table.Row data-model={`${row.model.provider}/${row.model.model}`}>
            <Table.Cell>
              <ModelName name={row.name} identifier={row.model.model} />
            </Table.Cell>
            <Table.Cell>{formatModelAbilities(row.model)}</Table.Cell>
            <Table.Cell>{formatContext(row.model.contextWindowTokens)}</Table.Cell>
            <Table.Cell>
              <StatusDot
                status={row.allowed ? 'success' : 'neutral'}
                label={row.allowed ? copy.allowed : copy.notAllowed}
                labelVisible
              />
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {:else}
    <FormSection grouped heading={copy.heading} description={copy.emptyDescription}>
      {#if failure !== undefined}
        <ErrorState
          headingLevel={3}
          title={copy.loadFailed.title}
          description={copy.loadFailed.description(failure.providers, failure.status)}
          retryLabel={copy.loadFailed.retry}
          {onRetry}
          data-testid="models-catalog-failed"
        />
      {:else}
        <EmptyState
          kind="first-use"
          headingLevel={3}
          title={copy.empty.title}
          description={copy.empty.description}
          data-testid="models-empty"
        >
          {#snippet icon()}<Cpu size={24} aria-hidden="true" />{/snippet}
          {#snippet action()}
            <Link href={PROVIDERS_ANCHOR} onclick={goToProviders}>{copy.empty.action}</Link>
          {/snippet}
        </EmptyState>
      {/if}
    </FormSection>
  {/if}
</div>

<style>
  .ib-models {
    min-inline-size: 0;
  }
</style>
