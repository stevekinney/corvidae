<script lang="ts">
  import { default as Steps } from '@lostgradient/steps/components/steps/index.ts';

  const steps = [
    { id: 'account', label: 'Account', description: 'Set up your account', href: '#account' },
    { id: 'details', label: 'Details', description: 'Add your details', href: '#details' },
    { id: 'review', label: 'Review', description: 'Review your choices', href: '#review' },
  ];
</script>

<div class="steps-fixture">
  <Steps {steps} currentStep={0} label="Checkout progress" />
</div>
