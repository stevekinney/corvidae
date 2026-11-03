<script lang="ts" module>
  export const title = 'Title and actions';
  export const description =
    'A warning banner with a bold title, a line of detail and two secondary actions.';
</script>

<script lang="ts">
  import { Banner, Button } from '@lostgradient/cinder';
</script>

<Banner variant="warning" dismissible={false} title="1 change waits for a restart">
  Workflow claim renew interval. Running work picks up where it stopped; reviews stay waiting.
  {#snippet actions()}
    <Button variant="secondary" size="sm" label="Revert 1 change" />
    <Button variant="secondary" size="sm" label="Restart now" />
  {/snippet}
</Banner>
