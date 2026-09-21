<script lang="ts">
  import { Accordion } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let item1Id = $derived(`${mountIdPrefix ?? uid}-item-1`);
  let item2Id = $derived(`${mountIdPrefix ?? uid}-item-2`);
  let item3Id = $derived(`${mountIdPrefix ?? uid}-item-3`);

  let expandedIds = $state<string[]>([]);
</script>

<Accordion bind:expandedIds>
  <Accordion.Item id={item1Id} title="What is Cinder?">
    Cinder is a Svelte 5 design system built for composability and accessibility.
  </Accordion.Item>
  <Accordion.Item id={item2Id} title="How do I install it?">
    In this workspace, add <code>@lostgradient/cinder</code> as a workspace dependency and import
    components from <code>@lostgradient/cinder</code>.
  </Accordion.Item>
  <Accordion.Item id={item3Id} title="Does it support SSR?">
    Yes — every component is SSR-safe and renders meaningful HTML before hydration.
  </Accordion.Item>
</Accordion>
