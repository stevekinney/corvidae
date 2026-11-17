<script lang="ts" module>
  export const title = 'A schema with no fields';
  export const description =
    'One line in a bordered box instead of an empty grid, with the raw document still one disclosure away.';
</script>

<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';
</script>

<SchemaView schema={{ type: 'object', properties: {} }} label="Workflow without input" />
