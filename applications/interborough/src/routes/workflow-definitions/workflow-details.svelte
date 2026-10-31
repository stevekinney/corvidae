<script lang="ts">
  /**
   * What a workflow says beyond what a person acts on: where its file is, its trigger as written,
   * and what the engine's contract declares (the signals, updates, and queries it accepts, and the
   * schemas of its input and output). Only what the workflow has is shown: a fact it does not have
   * is no row, and the page shows no disclosure when there is nothing to put in it.
   */
  import { CodeBlock, CodeLocation } from '@lostgradient/cinder';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import type { WorkflowDocument } from '../../lib/workflow-files.ts';
  import { triggerLabel, type DefinitionDetails } from './workflow-presentation.ts';

  interface Props {
    details: DefinitionDetails;
    /** The workflow's file path, for an agent-authored workflow. */
    filePath?: string | undefined;
    /** The file's document, whose trigger is shown as written. */
    document?: WorkflowDocument | undefined;
    /** Whether the host keeps the file on this machine or in a bucket, which changes what the label says. */
    mode?: 'local' | 'remote' | undefined;
  }

  let { details, filePath, document, mode = 'local' }: Props = $props();

  const copy = WORKFLOW_COPY;
</script>

{#snippet identifiers(label: string, entries: readonly string[], testId?: string)}
  {#if entries.length > 0}
    <dt>{label}</dt>
    <dd data-testid={testId}>
      {#each entries as entry, index (entry)}{#if index > 0}{', '}{/if}<code>{entry}</code>{/each}
    </dd>
  {/if}
{/snippet}

{#snippet schema(label: string, text: string | undefined)}
  {#if text !== undefined}
    <h3 class="ib-workflow__subheading">{label}</h3>
    <CodeBlock code={text} language="json" highlight={false} />
  {/if}
{/snippet}

<div class="ib-workflow__section" data-testid="workflow-definition">
  <dl class="weft-workflow-facts">
    {#if filePath !== undefined}
      <dt>{mode === 'remote' ? copy.remote.fileLabel : copy.fileLabel}</dt>
      <dd>
        <CodeLocation class="weft-code-location" file={filePath} data-testid="workflow-file-path" />
      </dd>
    {/if}
    {#if document !== undefined}
      <dt>{copy.page.trigger}</dt>
      <dd data-testid="workflow-trigger-source">{triggerLabel(document.trigger)}</dd>
    {/if}
    {@render identifiers(copy.page.signals, details.signals, 'workflow-accepted-signals')}
    {@render identifiers(copy.page.updates, details.updates)}
    {@render identifiers(copy.page.queries, details.queries)}
  </dl>
  {@render schema(copy.page.inputSchema, details.inputSchema)}
  {@render schema(copy.page.outputSchema, details.outputSchema)}
</div>
