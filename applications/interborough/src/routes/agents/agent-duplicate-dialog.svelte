<script lang="ts">
  /**
   * The question before Duplicate on a plugin's code agent that a file cannot fully state: a Cinder
   * confirm dialog listing what the copy leaves out, which the Bureau stated before any write. The
   * list is Cinder's own treatment of a plain list in `options`, so the page draws no box and adds no
   * CSS for it. Confirming writes the copy and the dialog stays open, busy, until it answers: a
   * failure shows in the dialog with Duplicate armed as the retry, and success closes it.
   */
  import { ConfirmDialog } from '@lostgradient/cinder';

  import { AGENT_PAGE_COPY, droppedBehaviorWords } from '../../app/copy/agents.ts';

  interface Props {
    open: boolean;
    /** What the agent is called, as a person reads it. */
    name: string;
    /** The names the Bureau gave for what the copy leaves out, each shown whatever it is. */
    dropped: readonly string[];
    /** True while the copy is being written. */
    busy: boolean;
    /** Why the last write failed, or `null`. */
    error: string | null;
    /** The button that opened the dialog, where focus returns. */
    triggerRef: HTMLElement | null;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    open = $bindable(),
    name,
    dropped,
    busy,
    error,
    triggerRef,
    onConfirm,
    onCancel,
  }: Props = $props();

  const copy = AGENT_PAGE_COPY.plugin;
</script>

<ConfirmDialog
  bind:open
  {triggerRef}
  title={copy.confirm.title(name)}
  description={copy.confirm.description}
  confirmLabel={copy.duplicate}
  busyLabel={copy.confirm.busy}
  closeOnConfirm={false}
  {busy}
  errorTitle={error === null ? undefined : copy.confirm.errorTitle}
  error={error ?? undefined}
  {onConfirm}
  {onCancel}
>
  {#snippet options()}
    <ul data-testid="agent-duplicate-dropped">
      {#each dropped as wireName (wireName)}
        {@const words = droppedBehaviorWords(wireName)}
        <li data-dropped={wireName}>
          <strong>{words.name}</strong>{#if words.effect !== null}{' '}{words.effect}{/if}
        </li>
      {/each}
    </ul>
  {/snippet}
</ConfirmDialog>
