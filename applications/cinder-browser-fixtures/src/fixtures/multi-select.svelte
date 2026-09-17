<script lang="ts">
  import { MultiSelect } from '@repo/cinder';
  const items = ['apple', 'banana', 'cherry', 'mango', 'orange'].map((id) => ({
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
  }));
  let selected = $state(['banana']);
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-example-preview-ready="">
    <MultiSelect id="fruit" label="Fruits" {items} bind:selectedIds={selected} />
  </div>
</section>
