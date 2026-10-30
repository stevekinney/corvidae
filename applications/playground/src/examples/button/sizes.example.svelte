<script lang="ts" module>
  export const title = 'Button sizes';
  export const description =
    'xs, sm, md, and lg sizes, on the shared 24/28/32/40px control height scale.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <Button size="xs" label="Extra Small" />
  <Button size="sm" label="Small" />
  <Button size="md" label="Medium" />
  <Button size="lg" label="Large" />
</div>
