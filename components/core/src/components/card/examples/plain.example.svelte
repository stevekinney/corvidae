<script lang="ts" module>
  export const title = 'Plain';
  export const description =
    'A plain card is a heading and its content on the page, with no box: no fill, no border and no shadow. Shown beside the default card.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <Card title="Default card">
    <p style="margin: 0; color: var(--cinder-text-muted);">
      A raised surface with a hairline edge.
    </p>
  </Card>
  <Card variant="plain" title="Plain card">
    <p style="margin: 0; color: var(--cinder-text-muted);">A heading on the page with no box.</p>
  </Card>
</div>
