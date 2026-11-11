<script lang="ts">
  import { DecisionDeck } from '@lostgradient/cinder';

  const items = [
    {
      id: 'receipts',
      eyebrow: 'Receipts',
      title: 'Archive receipts',
      description: 'Move mail from receipts@shop.example to the Receipts label.',
    },
    {
      id: 'digest',
      eyebrow: 'News Weekly',
      title: 'Label the weekly digest',
      description: 'Add the Reading label to mail from digest@news.example.',
    },
    {
      id: 'invoices',
      eyebrow: 'Billing',
      title: 'Star invoices',
      description: 'Star mail whose subject starts with Invoice.',
    },
  ];
</script>

<!-- Fixture pages force every transition to 0s; the spring test needs this subtree's motion. -->
<div id="example-mount-basic" data-preserve-motion>
  <DecisionDeck label="Review queue" {items} />
</div>
