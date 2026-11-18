<script lang="ts">
  import { default as JsonEditor } from '@lostgradient/json-editor/components/json-editor/index.ts';

  let value = $state('{\n  "region": "us-west-2",\n  "dryRun": true\n}');
</script>

<JsonEditor
  id="payload"
  label="Request payload"
  description="Enter the JSON body sent with the request."
  {value}
  onValueChange={(nextValue) => (value = nextValue)}
/>
