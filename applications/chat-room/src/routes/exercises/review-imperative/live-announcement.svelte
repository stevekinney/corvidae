<script lang="ts">
  let { announcement }: { announcement: string } = $props();
  let announceMutations = $state(0);
  let regionNode = $state<HTMLElement | null>(null);

  $effect(() => {
    if (!regionNode) return;
    const observer = new MutationObserver((records) => {
      announceMutations += records.length;
    });
    observer.observe(regionNode, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  });
</script>

<p
  aria-live="polite"
  aria-atomic="true"
  bind:this={regionNode}
  data-testid="announcement"
  style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;"
>
  {announcement}
</p>

<p data-testid="announce-mutations" style="display: none;">{announceMutations}</p>
