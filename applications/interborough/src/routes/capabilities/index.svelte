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
   */
  import { untrack } from 'svelte';

  import { PageHeader, Tabs } from '@lostgradient/cinder';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
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

<section class="ib-capabilities" data-page="capabilities">
  <PageHeader title={copy.title} description={copy.description} />
  <Tabs bind:value={activeTab} onValueChange={writeTab}>
    <Tabs.List label={copy.tabsLabel}>
      <Tabs.Trigger value="tools">{copy.tabs.tools}</Tabs.Trigger>
      <Tabs.Trigger value="skills">{copy.tabs.skills}</Tabs.Trigger>
      <Tabs.Trigger value="sources">{copy.tabs.sources}</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Panel value="tools"><ToolsPanel /></Tabs.Panel>
    <Tabs.Panel value="skills"><SkillsPanel /></Tabs.Panel>
    <Tabs.Panel value="sources"><SourcesPanel /></Tabs.Panel>
  </Tabs>
</section>
