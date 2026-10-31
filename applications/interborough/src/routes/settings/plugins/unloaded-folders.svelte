<script lang="ts">
  /**
   * The folders the host could not load a plugin from. They have no name, because their code never
   * ran, so they are listed by where they are, with what went wrong, apart from the plugins that
   * loaded.
   */
  import { Alert, SectionHeading, StatusDot } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import type { UnloadedPlugin } from '../../../lib/host-plugins.ts';
  import { keyedByOccurrence } from '../../../lib/list-keys.ts';
  import { sourceWord } from './plugin-presentation.ts';
  import { problemView } from './plugin-problems.ts';

  interface Props {
    folders: readonly UnloadedPlugin[];
  }

  let { folders }: Props = $props();

  const copy = PLUGINS_COPY.unloaded;
</script>

<section class="ib-unloaded" aria-label={copy.heading} data-testid="plugins-unloaded">
  <SectionHeading level={2} title={copy.heading} description={copy.description} />
  <ul class="ib-unloaded__list">
    {#each keyedByOccurrence(folders, (candidate) => candidate.location) as { key, item: folder } (key)}
      <li class="ib-unloaded__item" data-unloaded={folder.location}>
        <div class="ib-unloaded__where">
          <code class="ib-unloaded__location">{folder.location}</code>
          <span class="ib-unloaded__source">{sourceWord(folder.source)}</span>
          <StatusDot status="danger" label={PLUGINS_COPY.status.notLoaded} labelVisible size="sm" />
        </div>
        {#each folder.problems as problem, index (index)}
          {@const view = problemView(problem)}
          <Alert variant="warning" data-plugin-problem={problem.code}>
            <p class="ib-unloaded__problem-title">{view.title}</p>
            <p class="ib-unloaded__problem-body">{view.body}</p>
          </Alert>
        {/each}
      </li>
    {/each}
  </ul>
</section>

<style>
  .ib-unloaded {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-unloaded__list {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-unloaded__item {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-unloaded__where {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-3);
  }

  .ib-unloaded__location {
    flex: 1 1 12rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-unloaded__source {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-unloaded__problem-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-unloaded__problem-body {
    margin: var(--cinder-space-1) 0 0;
    overflow-wrap: anywhere;
  }
</style>
