<script lang="ts">
  /**
   * The tabs inside How it ran (COR-2424, row 54i): Steps, Inspector, Raw payloads and Events and
   * logs, then Versioning and Search attributes, each drawn only when the page gives it something
   * to hold. Steps is open first. A tab's panel is drawn only while it is chosen, and each panel
   * keeps the `data-section` its contents always had.
   */
  import { Tabs } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';

  interface RunHowItRanTabsProps {
    steps: Snippet;
    inspector?: Snippet | undefined;
    raw?: Snippet | undefined;
    events?: Snippet | undefined;
    versioning?: Snippet | undefined;
    attributes?: Snippet | undefined;
    /** The tab that is open; the page opens Raw payloads from the link under a reply. */
    active?: string;
  }

  let {
    steps,
    inspector,
    raw,
    events,
    versioning,
    attributes,
    active = $bindable('steps'),
  }: RunHowItRanTabsProps = $props();

  const copy = RUN_DETAIL_COPY.howItRan.tabs;
  type TabEntry = { value: string; label: string; content: Snippet };
  const tabs = $derived.by((): TabEntry[] => {
    const all: { value: string; label: string; content: Snippet | undefined }[] = [
      { value: 'steps', label: copy.steps, content: steps },
      { value: 'inspector', label: copy.inspector, content: inspector },
      { value: 'raw', label: copy.raw, content: raw },
      { value: 'events', label: copy.events, content: events },
      { value: 'versioning', label: copy.versioning, content: versioning },
      { value: 'attributes', label: copy.attributes, content: attributes },
    ];
    return all.flatMap((tab) =>
      tab.content === undefined
        ? []
        : [{ value: tab.value, label: tab.label, content: tab.content }],
    );
  });

  // A tab that is no longer drawn (its run has nothing in it any more) gives way to Steps.
  const chosen = $derived(tabs.some((tab) => tab.value === active) ? active : 'steps');
</script>

{#if tabs.length === 1}
  <!-- Only Steps has something in it (a run only the Bureau's record holds): no tab bar of one. -->
  {@render steps()}
{:else}
  <Tabs bind:value={() => chosen, (value) => (active = value)}>
    <Tabs.List label={copy.label}>
      {#each tabs as tab (tab.value)}
        <Tabs.Trigger value={tab.value}>{tab.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#each tabs as tab (tab.value)}
      <Tabs.Panel value={tab.value}>
        {@render tab.content()}
      </Tabs.Panel>
    {/each}
  </Tabs>
{/if}
