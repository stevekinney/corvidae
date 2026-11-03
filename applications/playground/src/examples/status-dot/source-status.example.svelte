<script lang="ts" module>
  export const title = 'Source status lines';
  export const description =
    'A connected source reads a green dot with a muted “Connected”; a source whose sign-in expired reads an amber dot with “Needs sign-in”, the reason and the same type chip. The word, not the colour, carries the meaning.';
</script>

<script lang="ts">
  import { Chip, StatusDot } from '@lostgradient/cinder';
</script>

<div class="example-preview-column">
  <div class="example-preview-row">
    <StatusDot word="Connected" />
    <span>Signed in as you · last tested 2 min ago</span>
    <Chip label="MCP server" />
  </div>
  <div class="example-preview-row">
    <StatusDot word="Needs sign-in" />
    <span>Your GitHub sign-in expired on Oct 31.</span>
    <Chip label="MCP server" />
  </div>
</div>
