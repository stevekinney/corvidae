<script lang="ts">
  /**
   * One line under a workflow's title: its facts joined by commas. A fact is plain words, an
   * identifier in monospace, a link (the schedule, the run), or a status word beside its dot. The
   * line's content comes from `workflow-page-presentation.ts`, so this draws and says nothing.
   */
  import { StatusDot } from '@lostgradient/cinder';

  import { router } from '../../lib/router.svelte.ts';
  import type { HeaderLine } from './workflow-page-presentation.ts';

  interface Props {
    line: HeaderLine;
  }

  let { line }: Props = $props();

  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }
</script>

<p class="ib-workflow__line" data-testid={`workflow-line-${line.id}`}>
  {#each line.parts as part, index (index)}
    {#if index > 0}{', '}{/if}
    <span class="ib-workflow-line__part">
      {#each part as run, position (position)}
        {#if run.word !== undefined}
          <StatusDot word={run.word} size="sm" />
        {:else if run.href !== undefined}
          {@const target = run.href}
          <a href={router.href(target)} onclick={(event) => go(event, target)}>{run.text}</a>
        {:else if run.code}
          <code>{run.text}</code>
        {:else}
          {run.text}
        {/if}
      {/each}
    </span>
  {/each}
</p>
