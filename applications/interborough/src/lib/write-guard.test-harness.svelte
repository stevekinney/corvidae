<script lang="ts">
  /**
   * Arms the write guard on a state of its own and calls `fetch` and `refuseWrite` inside an effect,
   * the way a component that opens a stream does, to count how often that effect runs.
   */
  import { untrack } from 'svelte';

  import { armWriteGuard, refuseWrite } from './write-guard.ts';

  interface Props {
    target: { fetch: typeof fetch };
    onRun: () => void;
    onReady: (control: { setDown: (down: boolean) => void }) => void;
  }

  let { target, onRun, onReady }: Props = $props();
  let down = $state(false);

  const disarm = untrack(() => armWriteGuard(() => down, ['http://localhost'], target));
  untrack(() => onReady)({ setDown: (value) => (down = value) });

  $effect(() => {
    onRun();
    void target.fetch('http://localhost/v1/workflows');
    refuseWrite('bureau.tasks.get');
  });
  $effect(() => disarm);
</script>
