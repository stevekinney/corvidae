<script lang="ts">
  /**
   * Advanced: the diagnostics that are not on a tab (rows 76o, 77e, 77f). It is a disclosure row at
   * the foot of Overview, collapsed, reading "Advanced, Metrics, alerts and checks". Opened, it
   * lists Metrics, Alerts and Checks, each with its own link on the right, and the one that is
   * opened shows its panel beneath the list. A link from elsewhere ("Open Diagnostics") opens it
   * expanded: the address carries `?advanced=` (`open`, or the section's name), so the state is
   * linkable and survives a reload. Realms is a fourth row only when the engine runs them.
   *
   * Checks counts the same problems as Needs attention, by area, from the one list the Bureau
   * gives, so opening Advanced never says all is well while the list above says otherwise.
   */
  import { Collapsible } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { type Attention } from '../../lib/bureau-attention.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import AlertsTab from '../system/alerts-tab.svelte';
  import ChecksPanel from './checks-panel.svelte';
  import MetricsTab from '../system/metrics-tab.svelte';
  import RealmsTab from '../system/realms-tab.svelte';
  import { fetchRealmDiagnostics, runsRealms } from '../system/realms-view.ts';
  import { HEALTH_ADVANCED_COPY as copy } from './health-copy.ts';
  import { clockTime } from './health-times.ts';

  interface Props {
    /** What needs attention, for the lines under Alerts and Checks; `undefined` until it is read. */
    attention: Attention | undefined;
  }

  let { attention }: Props = $props();

  const client = getClient();
  const SECTIONS = ['metrics', 'alerts', 'checks', 'realms'] as const;
  type Section = (typeof SECTIONS)[number];

  const requested = $derived(router.search.get('advanced'));
  const open = $derived(requested !== null);
  const section = $derived(SECTIONS.find((candidate) => candidate === requested));

  // The same read, under the same key, as Realms' own; a failed read lists no Realms.
  const fleetLive = useFleetEventsLive();
  const realms = createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.realms(),
      queryFn: () => fetchRealmDiagnostics(client),
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
      enabled: open,
    };
  });
  const hasRealms = $derived(runsRealms(realms.data));

  /** Writes `?advanced=`, keeping the rest of the address. */
  function show(next: string | null): void {
    const params = new URLSearchParams(router.search);
    if (next === null) params.delete('advanced');
    else params.set('advanced', next);
    const query = params.toString();
    router.navigate(`/health${query === '' ? '' : `?${query}`}`, { replace: true });
  }

  const firing = $derived(
    (attention?.items ?? []).flatMap((item) => (item.kind === 'alert' ? [item] : [])),
  );
  const alertsLine = $derived(
    copy.alerts.line(
      firing.map((item) => item.metric),
      firing.length === 0 ? null : clockTime(Math.min(...firing.map((item) => item.at))),
    ),
  );
  const checksLine = $derived(
    copy.checks.line(
      attention?.items.length ?? 0,
      (attention?.checks ?? []).map((check) => copy.areas[check.area]),
    ),
  );

  const rows = $derived<
    readonly { section: Section; title: string; line: string; action: string }[]
  >([
    {
      section: 'metrics',
      title: copy.metrics.title,
      line: copy.metrics.line,
      action: copy.metrics.action,
    },
    { section: 'alerts', title: copy.alerts.title, line: alertsLine, action: copy.alerts.action },
    { section: 'checks', title: copy.checks.title, line: checksLine, action: copy.checks.action },
    ...(hasRealms
      ? [
          {
            section: 'realms' as const,
            title: copy.realms.title,
            line: copy.realms.line,
            action: copy.realms.action,
          },
        ]
      : []),
  ]);
</script>

<Collapsible
  {open}
  onToggle={(next) => show(next ? 'open' : null)}
  chevron="start"
  class="ib-advanced"
  data-testid="advanced-diagnostics"
>
  {#snippet trigger()}
    <span class="ib-advanced__title">{copy.title}</span>
    <span class="ib-advanced__summary">{copy.summary}</span>
  {/snippet}

  <ul class="ib-advanced__rows">
    {#each rows as row (row.section)}
      <li class="ib-advanced__row" data-section={row.section}>
        <div class="ib-advanced__text">
          <p class="ib-advanced__row-title">{row.title}</p>
          <p class="ib-advanced__row-line">{row.line}</p>
        </div>
        <a
          class="ib-advanced__link"
          href={router.href(`/health?advanced=${row.section}`)}
          aria-expanded={section === row.section}
          onclick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            event.preventDefault();
            show(section === row.section ? 'open' : row.section);
          }}
        >
          {section === row.section ? copy.close : row.action} ›
        </a>
      </li>
      {#if section === row.section}
        <li class="ib-advanced__panel" aria-label={copy.sectionLabel(row.title)}>
          {#if row.section === 'metrics'}
            <MetricsTab />
          {:else if row.section === 'alerts'}
            <AlertsTab />
          {:else if row.section === 'checks'}
            <ChecksPanel {attention} />
          {:else}
            <RealmsTab />
          {/if}
        </li>
      {/if}
    {/each}
  </ul>
</Collapsible>

<style>
  :global(.ib-advanced) {
    min-width: 0;
  }

  .ib-advanced__title {
    font-weight: 600;
  }

  .ib-advanced__summary {
    margin-inline-start: var(--cinder-space-3);
    color: var(--cinder-text-muted);
  }

  .ib-advanced__rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-advanced__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-4);
    padding-block: var(--cinder-space-3);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-advanced__text {
    min-width: 0;
  }

  .ib-advanced__row-title,
  .ib-advanced__row-line {
    margin: 0;
  }

  .ib-advanced__row-title {
    font-weight: 600;
  }

  .ib-advanced__row-line {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-advanced__link {
    color: var(--cinder-accent-text);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    text-decoration: none;
  }

  .ib-advanced__link:hover {
    text-decoration: underline;
  }

  .ib-advanced__panel {
    padding-block: var(--cinder-space-4);
    list-style: none;
  }
</style>
