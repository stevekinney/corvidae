<script lang="ts">
  type Props = {
    label: string;
    onsetup?: () => void;
    onteardown?: () => void;
  };

  let { label, onsetup, onteardown }: Props = $props();
  let clicks = $state(0);

  $effect(() => {
    onsetup?.();
    return () => onteardown?.();
  });
</script>

<div data-testid="harness-probe">
  <span data-testid="harness-label">{label}</span>
  <button type="button" onclick={() => (clicks += 1)}>Clicked {clicks} times</button>
</div>
