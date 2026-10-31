<script lang="ts">
  /**
   * One audit record: what happened, when, who did it, and what it is about, with a link to the
   * thing it is about. A record that names a value before and after shows the two side by side; any
   * other field it carries is listed as it is. The raw record is under a heading of its own.
   */
  import { CodeBlock, DescriptionList, SectionHeading } from '@lostgradient/cinder';

  import { AUDIT_COPY } from '../../app/copy.ts';
  import type { AuditRecord } from '../../lib/bureau-audit.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { changeOf, resourcePath } from './audit-filter.ts';

  interface Props {
    record: AuditRecord;
  }

  let { record }: Props = $props();

  const copy = AUDIT_COPY;
  const change = $derived(changeOf(record.detail));
  const target = $derived(resourcePath(record.resource));
  const facts = $derived([
    { term: copy.fact.what, definition: whatText },
    { term: copy.fact.when, definition: { type: 'timestamp' as const, value: record.timestamp } },
    { term: copy.fact.who, definition: record.principal ?? copy.noActor },
    { term: copy.fact.about, definition: aboutLink },
  ]);
  const detailItems = $derived(change.rest.map(([term, definition]) => ({ term, definition })));
</script>

{#snippet whatText()}<span class="ib-audit__mono">{record.type}</span>{/snippet}

{#snippet aboutLink()}
  {#if target === undefined}
    <span class="ib-audit__mono">{record.resource}</span>
  {:else}
    <a
      class="ib-audit__mono"
      href={target}
      aria-label={copy.openResource(record.resource)}
      onclick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        router.navigate(target);
      }}>{record.resource}</a
    >
  {/if}
{/snippet}

<article class="ib-audit__detail" data-testid="audit-detail" data-record={record.sequence ?? ''}>
  <h3 class="ib-audit__detail-title ib-audit__mono">{record.type}</h3>
  <DescriptionList items={facts} />

  {#if change.before !== undefined || change.after !== undefined}
    <section class="ib-audit__section" data-testid="audit-change">
      <SectionHeading level={4} title={copy.fact.beforeAfter} />
      <div class="ib-audit__change">
        <div>
          <p class="ib-audit__change-label">{copy.fact.before}</p>
          <p class="ib-audit__mono ib-audit__change-value" data-testid="audit-before">
            {change.before ?? ''}
          </p>
        </div>
        <div>
          <p class="ib-audit__change-label">{copy.fact.after}</p>
          <p class="ib-audit__mono ib-audit__change-value" data-testid="audit-after">
            {change.after ?? ''}
          </p>
        </div>
      </div>
    </section>
  {/if}

  {#if detailItems.length > 0}
    <section class="ib-audit__section">
      <SectionHeading level={4} title={copy.fact.details} />
      <DescriptionList items={detailItems} />
    </section>
  {/if}

  <section class="ib-audit__section">
    <SectionHeading level={4} title={copy.rawRecord} />
    <CodeBlock code={JSON.stringify(record, null, 2)} language="json" highlight={false} copyable />
  </section>
</article>

<style>
  .ib-audit__detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-audit__detail-title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-audit__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-audit__mono {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-audit__change {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
    gap: var(--cinder-space-3);
  }

  .ib-audit__change-label {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .ib-audit__change-value {
    margin: 0;
  }
</style>
