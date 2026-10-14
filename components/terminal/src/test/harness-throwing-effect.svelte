<script lang="ts">
  type Props = {
    /** Called when the component's teardown runs. */
    onteardown?: () => void;
    /** Make the teardown itself throw, to prove a failed unmount cannot mask the mount error. */
    teardownThrows?: boolean;
  };

  let { onteardown, teardownThrows = false }: Props = $props();

  $effect(() => () => {
    onteardown?.();
    if (teardownThrows) throw new Error('teardown failed');
  });

  $effect(() => {
    throw new Error('effect failed');
  });
</script>
