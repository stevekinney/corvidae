<script lang="ts" module>
  export const title = 'Editable title';
  export const description =
    'variant="bare" is text that looks like a 600-weight title and is edited in place: no border at rest, a hover tint, and the control fill under the focus ring.';
</script>

<script lang="ts">
  import { Input } from '@lostgradient/cinder';

  let name = $state('Spring menu launch');
</script>

<Input
  id="project-title"
  bind:value={name}
  label="Project title"
  labelVisible={false}
  variant="bare"
/>
