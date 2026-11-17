<script lang="ts" module>
  export const title = 'Long names and unbroken values';
  export const description =
    'A long field name truncates on one line and its full name is its tooltip, with the required dot after it. A value with no spaces breaks inside its cell and never widens the grid.';
</script>

<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';

  const longValuesSchema = {
    type: 'object',
    required: ['order_notes_exceptionally_long_field_name_that_keeps_going_and_going'],
    properties: {
      order_notes_exceptionally_long_field_name_that_keeps_going_and_going: {
        type: 'string',
        description: 'Free text the agent reads before it answers.',
      },
      trackingCode: {
        enum: ['QmVkS3Jvbm9zUHJpbWVWZXJ0ZXhDb250cm9sbGVyU2Vzc2lvblRva2VuQmFzZTY0…', 'other'],
        description: 'A carrier’s tracking code, kept exactly as given.',
      },
    },
  };
</script>

<div class="schema-view-long-values">
  <SchemaView schema={longValuesSchema} label="Order notes" />
</div>

<style>
  .schema-view-long-values {
    max-inline-size: 36rem;
  }
</style>
