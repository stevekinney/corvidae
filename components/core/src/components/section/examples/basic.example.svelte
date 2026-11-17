<script lang="ts" module>
  export const title = 'A heading, an action and content';
  export const description =
    'A section is a heading with an optional description and action, then its content. Space separates it from the next section; nothing is boxed.';
</script>

<script lang="ts">
  import { Button, Section } from '@lostgradient/cinder';
</script>

{#snippet actions()}
  <Button size="sm" variant="secondary">See all</Button>
{/snippet}

<Section title="Upcoming" description="The next seven days" {actions}>
  <p>Two bars and a rooftop are open late on Friday.</p>
</Section>

<Section title="Saved">
  <p>Nothing saved yet.</p>
</Section>
