<script lang="ts">
  import { Steps } from '@repo/cinder';

  const steps = [
    { id: 'account', label: 'Account', description: 'Set up your account', href: '#account' },
    { id: 'details', label: 'Details', description: 'Add your details', href: '#details' },
    { id: 'review', label: 'Review', description: 'Review your choices', href: '#review' },
  ];
</script>

<div class="steps-fixture">
  <Steps {steps} currentStep={0} label="Checkout progress" />
</div>
