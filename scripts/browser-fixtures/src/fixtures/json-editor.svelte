<script lang="ts">
  import { JsonEditor } from '@lostgradient/cinder';

  let value = $state('{\n  "region": "us-west-2",\n  "dryRun": true\n}');
</script>

<JsonEditor
  id="payload"
  label="Request payload"
  description="Enter the JSON body sent with the request."
  {value}
  onValueChange={(nextValue) => (value = nextValue)}
  highlight={true}
/>
