<script lang="ts" module>
  export const title = 'Card edge';
  export const description =
    'A card draws one edge, never two: a hairline border (the default) or a soft shadow.';
</script>

<script lang="ts">
  import { Card } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <Card edge="border" title="Border">
    <p style="margin: 0; color: var(--cinder-text-muted);">A hairline outline and no shadow.</p>
  </Card>
  <Card edge="shadow" title="Shadow">
    <p style="margin: 0; color: var(--cinder-text-muted);">A soft shadow and no visible border.</p>
  </Card>
</div>
