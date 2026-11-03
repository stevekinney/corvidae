<script lang="ts" module>
  export const title = 'All connection states';
  export const description =
    'Each of the seven states with its own word and glyph: a dot for live, a hollow ring for out of date, an icon for the rest. The word is always muted and the glyph carries the tone, so the glyph shape and the word carry the distinction, never color alone.';
</script>

<script lang="ts">
  import { ConnectionIndicator } from '@lostgradient/cinder';
</script>

<div class="example-preview-row">
  <ConnectionIndicator status="connecting" />
  <ConnectionIndicator status="live" />
  <ConnectionIndicator status="reconnecting" />
  <ConnectionIndicator status="polling" />
  <ConnectionIndicator status="stale" />
  <ConnectionIndicator status="out-of-date" />
  <ConnectionIndicator status="closed" />
</div>
