<script lang="ts">
  /**
   * One audit event, open beside the table: its title (who did what), the line that says when and
   * where, the facts of the record, the change an agent's version made to its instructions (a
   * Cinder `SourceDiffViewer` clamped to six lines, with Show all), the links that open what the
   * event is about, Copy as JSON, and the footer that says how long records are kept and what
   * Export saves.
   *
   * A very long target (a storage key can be thousands of characters) is cut with an ellipsis in
   * the table, and here it is whole: wrapped anywhere, in small monospace, under a heading that says
   * how long it is, with Copy key.
   */
  import {
    Button,
    copyToClipboard,
    Link,
    SourceDiffViewer,
    StatusDot,
    Text,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { AUDIT_COPY } from '../../app/copy/audit.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { listAgentVersions } from '../../lib/agent-definitions.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { instructionPatch } from './audit-diff.ts';
  import { LONG_TARGET_CHARACTERS, type AuditEvent, type AuditLookups } from './audit-events.ts';
  import { detailOf } from './audit-facts.ts';
  import { splitResource } from './audit-filter.ts';

  interface Props {
    event: AuditEvent;
    lookups: AuditLookups;
    /** The reference time for "Today" and "Yesterday", in epoch milliseconds. */
    now: number;
  }

  let { event, lookups, now }: Props = $props();

  /** The most lines of a long change the pane shows before Show all. */
  const DIFF_LINES = 6;

  const copy = AUDIT_COPY;
  const model = $derived(detailOf(event, lookups, now));
  const json = $derived(JSON.stringify(event.record, null, 2));

  // The change an agent's version made to its instructions: the Bureau keeps each saved version's
  // definition, and the record names the version it made and the one before it.
  const agentId = $derived(
    event.record.type === 'agent.updated' ? splitResource(event.record.resource).id : undefined,
  );
  const revision = $derived(event.record.detail?.['revision']);
  const previous = $derived(event.record.detail?.['previousRevision']);
  const changedKeys = $derived(String(event.record.detail?.['changedKeys'] ?? ''));
  const versions = createQuery(
    () => ({
      queryKey: queryKeys.agents.versions(agentId ?? ''),
      queryFn: ({ signal }) => listAgentVersions(agentId ?? '', { signal }),
      enabled:
        agentId !== undefined &&
        typeof revision === 'number' &&
        typeof previous === 'number' &&
        changedKeys.split(',').includes('instructions'),
      retry: false,
      staleTime: 60_000,
    }),
    undefined,
  );
  const patch = $derived.by(() => {
    const list = versions.data;
    if (list === undefined) return undefined;
    const before = list.find((version) => version.revision === previous)?.definition?.instructions;
    const after = list.find((version) => version.revision === revision)?.definition?.instructions;
    return before === undefined || after === undefined
      ? undefined
      : instructionPatch(before, after);
  });

  /** Copies `value` and says so in a toast, or says it could not. */
  async function copyValue(value: string, done: string): Promise<void> {
    const copied = await copyToClipboard(value);
    showToast(copied ? done : copy.copyFailed, { variant: copied ? 'success' : 'danger' });
  }

  const longTarget = $derived(event.target.length > LONG_TARGET_CHARACTERS);
  // The whole target, not the table's line: a storage key, which is the resource past its prefix.
  const wholeTarget = $derived(
    event.record.type === 'storage.key.deleted'
      ? event.record.resource.replace(/^storage:/, '')
      : event.target,
  );
</script>

<article
  class="ib-audit-detail"
  data-testid="audit-detail"
  data-record={event.record.sequence ?? ''}
>
  <header class="ib-audit-detail__heading">
    <h3 class="ib-audit-detail__title">{event.title}</h3>
    <p class="ib-audit-detail__when">{model.whenLine}</p>
  </header>

  {#if model.facts.length > 0}
    <div class="ib-audit-detail__facts" data-testid="audit-facts" {@attach followLinks}>
      <!-- One list for every fact, flat: hairlines between the rows and no box around any of them. -->
      <dl class="ib-audit-detail__fact-list">
        {#each model.facts as fact (fact.term)}
          <div class="ib-audit-detail__fact">
            <dt>{fact.term}</dt>
            <dd>
              {#if fact.value.kind === 'text'}
                <span class:ib-audit-detail__muted={fact.value.muted === true}
                  >{fact.value.text}</span
                >
              {:else if fact.value.kind === 'link'}
                <Link href={router.href(fact.value.href)}>{fact.value.text}</Link>
              {:else if fact.value.kind === 'tool'}
                <span>{fact.value.title}</span>
                <code class="ib-audit-detail__code">{fact.value.identifier}</code>
              {:else}
                <StatusDot word={fact.value.word} />
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}

  {#if patch !== undefined}
    <div class="ib-audit-detail__diff" data-testid="audit-instruction-diff">
      <SourceDiffViewer
        {patch}
        maxLines={DIFF_LINES}
        lineNumbers={false}
        headers={false}
        ariaLabel={copy.instructionsLabel}
      />
    </div>
  {/if}

  {#if longTarget}
    <section class="ib-audit-detail__target" data-testid="audit-target">
      <p class="ib-audit-detail__target-heading">{copy.targetHeading(wholeTarget.length)}</p>
      <Text clamp={3} class="ib-audit-detail__target-value">{wholeTarget}</Text>
      <div>
        <Button
          variant="secondary"
          size="sm"
          onclick={() => void copyValue(wholeTarget, copy.copiedKey)}>{copy.copyKey}</Button
        >
      </div>
    </section>
  {/if}

  <div class="ib-audit-detail__actions" {@attach followLinks}>
    {#each model.links as link (link.href)}
      <Link href={router.href(link.href)}>{link.label} ›</Link>
    {/each}
    <Button variant="secondary" size="sm" onclick={() => void copyValue(json, copy.copiedAsJson)}
      >{copy.copyAsJson}</Button
    >
  </div>

  <p class="ib-audit-detail__footer" {@attach followLinks}>
    {copy.retention.before}<Link
      underline="always"
      href={router.href('/settings/data-and-retention')}>{copy.retention.link}</Link
    >{copy.retention.after}
  </p>
</article>

<style>
  .ib-audit-detail {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-audit-detail__heading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
  }

  .ib-audit-detail__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .ib-audit-detail__when {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-audit-detail__facts {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .ib-audit-detail__fact-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    min-width: 0;
  }

  .ib-audit-detail__fact {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding-block: var(--cinder-space-2);
  }

  .ib-audit-detail__fact + .ib-audit-detail__fact {
    border-block-start: 1px solid var(--cinder-border-muted);
  }

  .ib-audit-detail__fact dt {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-audit-detail__fact dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-audit-detail__muted {
    color: var(--cinder-text-muted);
  }

  .ib-audit-detail__code {
    margin-inline-start: var(--cinder-space-1);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }

  .ib-audit-detail__diff {
    min-width: 0;
  }

  .ib-audit-detail__target {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-audit-detail__target-heading {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  /* Wrapped anywhere, so a value with no break in it never widens the pane or the page. */
  .ib-audit-detail__target :global(.ib-audit-detail__target-value) {
    margin: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .ib-audit-detail__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-audit-detail__footer {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
