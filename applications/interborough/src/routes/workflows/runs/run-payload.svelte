<script lang="ts">
  /**
   * One payload card of a run's page: Cinder's `PayloadInspector`, with its Fields or JSON choice
   * shared with every other card on the page (`payloadViewPreference`), and a value that names a chat,
   * an agent or a run written as a link under that thing's own name. Only the Fields view is linked;
   * the JSON view keeps the stored keys and values.
   *
   * The chats, agents and runs the payload names are read here, and a value whose thing the Bureau
   * does not have (or whose read failed) stays plain text, never a dead link. A click on a link opens
   * it in place, and a modified click is left to the browser.
   */
  import { PayloadInspector, type PayloadInspectorField } from '@lostgradient/cinder';
  import { createQueries, createQuery } from '@tanstack/svelte-query';

  import { getContext, listAgents } from '../../../lib/bureau-client.ts';
  import { getTask } from '../../../lib/bureau-tasks.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import {
    payloadLinkFor,
    payloadReferences,
    payloadValueText,
    type PayloadLookups,
  } from './run-payload-links.ts';
  import { payloadViewPreference } from './run-payload-view.svelte.ts';

  interface RunPayloadProps {
    /** The payload: the workflow's input or result, or the Bureau's record of a trigger. */
    value: unknown;
    /** The card's heading, such as "Input" or "Output"; it also names the card. */
    label: string;
  }

  let { value, label }: RunPayloadProps = $props();

  const references = $derived(payloadReferences(value));

  const chats = createQueries(() => ({
    queries: references.chats.map((id) => ({
      queryKey: queryKeys.contexts.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getContext(id, { signal }),
      retry: false,
    })),
  }));
  const runs = createQueries(() => ({
    queries: references.runs.map((id) => ({
      queryKey: queryKeys.bureauTasks.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getTask(id, { signal }),
      retry: false,
    })),
  }));
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      enabled: references.agents.length > 0,
      retry: false,
    }),
    undefined,
  );

  const lookups = $derived.by((): PayloadLookups => {
    const known = new Map<string, string>();
    references.chats.forEach((id, index) => {
      const read = chats[index]?.data;
      if (read !== undefined) known.set(id, read.title ?? '');
    });
    const knownAgents = new Map<string, string>();
    for (const agent of agents.data ?? []) {
      if (references.agents.includes(agent.name)) {
        knownAgents.set(agent.name, agentLabel(agent.name, agents.data));
      }
    }
    const knownRuns = new Set<string>();
    references.runs.forEach((id, index) => {
      if (runs[index]?.data !== undefined) knownRuns.add(id);
    });
    return { chats: known, agents: knownAgents, runs: knownRuns };
  });

  const linkFor = (field: PayloadInspectorField): string | undefined => {
    const path = payloadLinkFor(field, lookups);
    return path === undefined ? undefined : router.href(path);
  };
  const formatValue = (field: PayloadInspectorField): string | undefined =>
    payloadValueText(field, lookups);

  /** Opens a link of the Fields view in place, leaving a modified click to the browser. */
  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest('a.cinder-payload-inspector__link');
    const href = anchor?.getAttribute('href');
    if (href === null || href === undefined) return;
    event.preventDefault();
    router.navigate(href);
  }
</script>

<!-- The click is a delegate for the links the inspector draws; each link is itself focusable and reachable by keyboard. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="ib-run__payload" onclick={open}>
  <PayloadInspector
    {value}
    {label}
    redact={[]}
    {linkFor}
    {formatValue}
    bind:view={() => payloadViewPreference.view, (view) => payloadViewPreference.choose(view)}
  />
</div>
