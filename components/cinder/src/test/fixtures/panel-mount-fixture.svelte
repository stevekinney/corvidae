<script lang="ts">
  let { label = 'Panel' }: { label?: string } = $props();
</script>

<p data-testid="panel-mount-fixture">{label}</p>
