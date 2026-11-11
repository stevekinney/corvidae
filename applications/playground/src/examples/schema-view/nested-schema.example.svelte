<script lang="ts" module>
  export const title = 'A nested schema';
  export const description =
    'Required fields first with a red dot, nested objects indented, and the raw document behind the JSON schema disclosure.';
</script>

<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';

  const refundInput = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['orderId', 'customer'],
    properties: {
      orderId: { type: 'string', description: 'The order to refund.' },
      refundAmount: { type: 'number', description: 'Amount in cents. Defaults to the full order.' },
      customer: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'Where the receipt is sent.' },
          loyaltyTier: { type: 'string' },
        },
      },
    },
  };
</script>

<SchemaView schema={refundInput} label="Refund input" />
