<script lang="ts" module>
  export const title = 'Identical values';
  export const description =
    'When the two values are equal the viewer says so instead of rendering an empty list.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const value = { status: 'completed', exitCode: 0 };
</script>

<JsonDiffViewer before={value} after={{ ...value }} />
