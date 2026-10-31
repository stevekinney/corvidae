<script lang="ts">
  /**
   * The Models part of Settings › Models: the catalog, every model the connected providers offer,
   * with its context window, abilities and price. A switch turns a model off, to keep it from
   * agents and plans; Edit corrects a row, and Add a model adds one the built-in list lacks.
   *
   * Nothing is written until Save models. The switches and the row dialogs change a working copy of
   * the catalog edits, which the table shows laid over the rows the host serves, and Save sends the
   * whole list in one `PUT /host/catalog`. The host stores it in its configuration file and the
   * catalog takes it at once, so the change applies with no restart and survives one.
   */
  import { Alert, Badge, Button, EmptyState, Table, Toggle } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import { showToast } from '../../../app/toast-host.svelte';
  import {
    HostProviderError,
    replaceCatalogEdits,
    type CatalogEdit,
    type ProvidersSnapshot,
  } from '../../../lib/host-providers.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import {
    previewRows,
    withAddedRow,
    withModelOff,
    withRowFields,
    type AddedRow,
    type PreviewRow,
    type RowFields,
  } from './catalog-changes.ts';
  import { formatContext, formatPrice } from './format-model.ts';
  import RowDialog, { type RowDialogTarget } from './row-dialog.svelte';

  interface Props {
    snapshot: ProvidersSnapshot;
    /** Opens the Connect dialog, for the empty list's action. */
    onConnect: () => void;
  }

  let { snapshot, onConnect }: Props = $props();

  const copy = MODELS_COPY.models;
  const queryClient = useQueryClient();

  /** The edits being worked on, or `null` while the table shows what the host holds. */
  let working = $state<readonly CatalogEdit[] | null>(null);
  let saving = false;
  let savePending = $state(false);
  let failure = $state('');
  let dialog = $state<RowDialogTarget | null>(null);

  const edits = $derived(working ?? snapshot.catalog);
  const rows = $derived(previewRows(snapshot.models, edits));
  const locked = $derived(snapshot.lockReason !== undefined);
  const connected = $derived(
    snapshot.providers.filter((provider) => provider.hasKey).map((provider) => provider.name),
  );
  const dirty = $derived(
    working !== null && JSON.stringify(working) !== JSON.stringify(snapshot.catalog),
  );

  function change(next: readonly CatalogEdit[]): void {
    working = next;
    failure = '';
  }

  function abilitiesOf(row: PreviewRow): string[] {
    return [
      ...(row.tools ? [copy.abilities.tools] : []),
      ...(row.images ? [copy.abilities.images] : []),
      ...(row.structuredOutput ? [copy.abilities.structuredOutput] : []),
    ];
  }

  function discard(): void {
    working = null;
    failure = '';
  }

  async function save(): Promise<void> {
    if (saving || working === null) return;
    saving = true;
    savePending = true;
    failure = '';
    try {
      await replaceCatalogEdits(working);
      showToast(copy.saved, { variant: 'success' });
      // Read the host's rows again, and the agent editor's model choices with them. The edits stay
      // on the table until the rows that include them are here, so no row snaps back meanwhile.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
      try {
        await queryClient.invalidateQueries({ queryKey: queryKeys.hostProviders() });
      } finally {
        working = null;
      }
    } catch (error) {
      failure =
        error instanceof HostProviderError && error.message !== ''
          ? error.message
          : copy.saveFailed;
    } finally {
      saving = false;
      savePending = false;
    }
  }
</script>

<section class="ib-models" aria-labelledby="models-catalog-title" data-section="models">
  <div class="ib-models__title-row">
    <h2 id="models-catalog-title" class="ib-models__title">{copy.heading}</h2>
    {#if rows.length > 0}
      <Button
        variant="secondary"
        size="sm"
        disabled={locked || connected.length === 0}
        onclick={() => (dialog = { kind: 'add' })}>{copy.add}</Button
      >
    {/if}
  </div>
  <p class="ib-models__description">{copy.description}</p>

  {#if rows.length === 0}
    <EmptyState kind="first-use" title={copy.empty.title} description={copy.empty.description}>
      {#snippet action()}
        <Button variant="primary" disabled={locked} onclick={onConnect}>{copy.empty.action}</Button>
      {/snippet}
    </EmptyState>
  {:else}
    {#if failure !== ''}
      <Alert
        variant="danger"
        dismissible
        onDismiss={() => (failure = '')}
        data-testid="models-failure"
      >
        <p class="ib-models__alert-title">{copy.saveFailed}</p>
        <p class="ib-models__alert-body">{failure}</p>
      </Alert>
    {/if}
    <Table caption={copy.tableLabel} density="condensed">
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{copy.columns.model}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.context}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.abilities}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.price}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.on}</Table.HeaderCell>
          <Table.HeaderCell>{copy.columns.actions}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each rows as row (`${row.provider}/${row.model}`)}
          {@const abilities = abilitiesOf(row)}
          <Table.Row
            data-model={`${row.provider}/${row.model}`}
            data-off={row.off ? 'true' : 'false'}
          >
            <Table.Cell>
              <span class="ib-models__name">{row.provider}/{row.model}</span>
              {#if row.added}
                <Badge variant="neutral" size="sm">{copy.added}</Badge>
              {/if}
            </Table.Cell>
            <Table.Cell>{formatContext(row.contextWindowTokens)}</Table.Cell>
            <Table.Cell>
              {#if abilities.length === 0}
                <span class="ib-models__muted">{copy.noAbilities}</span>
              {:else}
                <span class="ib-models__abilities">
                  {#each abilities as ability (ability)}
                    <Badge variant="neutral" size="sm">{ability}</Badge>
                  {/each}
                </span>
              {/if}
            </Table.Cell>
            <Table.Cell>
              {#if row.pricing === undefined}
                <span class="ib-models__muted">{copy.noPrice}</span>
              {:else}
                {copy.price(
                  formatPrice(row.pricing.inputPerMillionTokens, row.pricing.currency),
                  formatPrice(row.pricing.outputPerMillionTokens, row.pricing.currency),
                )}
              {/if}
            </Table.Cell>
            <Table.Cell>
              <Toggle
                id={`model-on-${row.provider}-${row.model}`}
                label={copy.onLabel(`${row.provider}/${row.model}`)}
                labelVisible={false}
                checked={!row.off}
                disabled={locked || savePending}
                onValueChange={(next) => change(withModelOff(edits, row, !next))}
              />
            </Table.Cell>
            <Table.Cell>
              <Button
                variant="secondary"
                size="sm"
                disabled={locked || savePending}
                aria-label={copy.editLabel(`${row.provider}/${row.model}`)}
                onclick={() => (dialog = { kind: 'edit', row })}>{copy.edit}</Button
              >
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
    <div class="ib-models__actions">
      <Button
        data-changes
        variant="primary"
        disabled={!dirty || savePending || locked}
        loading={savePending}
        onclick={() => void save()}>{copy.save}</Button
      >
      <Button variant="secondary" disabled={!dirty || savePending} onclick={discard}
        >{copy.discard}</Button
      >
    </div>
  {/if}
</section>

<RowDialog
  bind:target={dialog}
  {rows}
  providers={connected}
  onEdit={(row: PreviewRow, fields: RowFields) => change(withRowFields(edits, row, fields))}
  onAdd={(added: AddedRow) => change(withAddedRow(edits, added))}
/>

<style>
  .ib-models {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-models__title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding-bottom: var(--cinder-space-2);
    border-bottom: 1px solid var(--cinder-border-muted);
  }

  .ib-models__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-models__description,
  .ib-models__muted {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-models__name {
    overflow-wrap: anywhere;
  }

  .ib-models__abilities {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
  }

  .ib-models__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-models__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-models__alert-body {
    margin: var(--cinder-space-1) 0 0;
    overflow-wrap: anywhere;
  }
</style>
