<script lang="ts" module>
  export const title = 'Card header divider';
  export const description =
    'The rule under the header is opt-in. Without headerDivider the header is separated from the body by its surface alone.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <Card title="No divider" description="The default.">
    <p style="margin: 0; color: var(--cinder-text-muted);">Body content.</p>
  </Card>
  <Card title="Divider" description="headerDivider is set." headerDivider>
    <p style="margin: 0; color: var(--cinder-text-muted);">Body content.</p>
  </Card>
</div>
