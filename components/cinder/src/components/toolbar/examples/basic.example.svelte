<script lang="ts" module>
  export const title = 'Basic toolbar';
  export const description = 'A named action bar that turns several controls into one Tab stop.';
</script>

<script lang="ts">
  import { Button, Toolbar } from '@lostgradient/cinder';
</script>

<Toolbar aria-label="Document actions">
  <Toolbar.Group>
    <Button variant="secondary">Save</Button>
    <Button variant="secondary">Share</Button>
    <Button variant="secondary">Export</Button>
  </Toolbar.Group>
</Toolbar>
