<script lang="ts">
  /**
   * `/capabilities`: what agents can use. Tools are the actions an agent can call, with what each
   * may do and how it is approved by default; skills are the instructions an agent can load, with
   * whether the host trusts where they came from. Each is a list with the open item beside it. The
   * tab is in the address (`?tab=skills`), and Tools is the address with no `tab`.
   *
   * Sources lists the MCP servers and OpenAPI services the host saved, with where each stands and
   * the tools it offers. The page reads, except for a source's Accepts secrets switches, Sign in
   * and Remove. Which skill sources are trusted is the host's configuration.
   *
   * Each tab carries how many it holds ("Tools 9", design row 31c), a dash while that has not
   * arrived (row 32f), read from the same queries the tabs' panels read.
   */
  import { PageHeader, Tabs } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { listSkillCatalog } from '../../lib/bureau-skills.ts';
  import { getToolSources } from '../../lib/host-tool-sources.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import SkillsPanel from './skills-panel.svelte';
  import SourcesPanel from './sources-panel.svelte';
  import ToolsPanel from './tools-panel.svelte';

  const copy = CAPABILITIES_COPY;
  const TABS = ['tools', 'skills', 'sources'] as const;

  function tabOf(search: URLSearchParams): string {
    const named = search.get('tab');
    return named !== null && (TABS as readonly string[]).includes(named) ? named : 'tools';
  }

  let activeTab = $state(untrack(() => tabOf(router.search)));

  // The same keys and options as each panel's own query, so each is read once and shared.
  const tools = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );
  const skills = createQuery(
    () => ({
      queryKey: queryKeys.skills.list(),
      queryFn: ({ signal }) => listSkillCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );
  const sources = createQuery(
    () => ({
      queryKey: queryKeys.toolSources.list(),
      queryFn: ({ signal }) => getToolSources({ signal }),
      retry: false,
    }),
    undefined,
  );

  /** A tab's count: how many it holds, or a dash while that is not known (loading, or it could not be read). */
  function countOf(length: number | undefined): string {
    return length === undefined ? copy.tabCountPending : String(length);
  }
  const toolCount = $derived(countOf(tools.data?.tools.length));
  const skillCount = $derived(countOf(skills.data?.skills.length));
  const sourceCount = $derived(countOf(sources.data?.sources.length));

  /** Puts a tab the person picked in the address; the open item belongs to a tab, so it is left behind. */
  function writeTab(next: string): void {
    if (tabOf(router.search) === next) return;
    router.navigate(next === 'tools' ? router.pathname : `${router.pathname}?tab=${next}`);
  }

  $effect(() => {
    const fromUrl = tabOf(router.search);
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });
</script>

{#snippet tabName(name: string, id: string, count: string)}
  {name}
  <span class="ib-capabilities__tab-count" data-testid={`tab-count-${id}`}>{count}</span>
{/snippet}

<section class="ib-capabilities" data-page="capabilities">
  <PageHeader title={copy.title} description={copy.description} />
  <Tabs bind:value={activeTab} onValueChange={writeTab}>
    <Tabs.List label={copy.tabsLabel}>
      <Tabs.Trigger value="tools" label={copy.tabs.tools}
        >{@render tabName(copy.tabs.tools, 'tools', toolCount)}</Tabs.Trigger
      >
      <Tabs.Trigger value="skills" label={copy.tabs.skills}
        >{@render tabName(copy.tabs.skills, 'skills', skillCount)}</Tabs.Trigger
      >
      <Tabs.Trigger value="sources" label={copy.tabs.sources}
        >{@render tabName(copy.tabs.sources, 'sources', sourceCount)}</Tabs.Trigger
      >
    </Tabs.List>
    <Tabs.Panel value="tools"><ToolsPanel /></Tabs.Panel>
    <Tabs.Panel value="skills"><SkillsPanel /></Tabs.Panel>
    <Tabs.Panel value="sources"><SourcesPanel /></Tabs.Panel>
  </Tabs>
</section>
