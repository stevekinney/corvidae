<script lang="ts">
  import { JsonViewer } from './index.ts';

  const value = {
    alpha: { nested: { first: true } },
    beta: { nested: { second: true } },
  };
</script>

<!-- Adjacent and nested object disclosures for measuring their actual coarse-pointer boxes. -->
<div data-testid="json-viewer-touch-targets">
  <JsonViewer {value} initialDepth={2} />
</div>
