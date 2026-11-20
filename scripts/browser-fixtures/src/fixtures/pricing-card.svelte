<script lang="ts">
  import { Container, PricingCard } from '@lostgradient/cinder';

  const plans = [
    {
      name: 'Starter',
      price: '$0',
      features: ['3 projects', 'Community support'],
      callToActionLabel: 'Start free',
    },
    {
      name: 'Pro',
      price: '$49 / month',
      features: ['Unlimited projects', 'Priority support', 'Team roles'],
      callToActionLabel: 'Choose Pro',
    },
    {
      name: 'Enterprise',
      price: 'Contact us',
      features: ['SSO + SCIM', 'Audit logs', 'Dedicated support'],
      callToActionLabel: 'Talk to sales',
    },
  ];

  let selectedPlan = $state('Pro');
</script>

<section class="padding-block-10">
  <Container maxWidth="wide">
    <div class="example-grid gap-6">
      <header class="header gap-2">
        <h2 class="h2">Pricing for teams of every size</h2>
        <p class="h2 text-muted">
          Start free, then scale with advanced collaboration and enterprise controls.
        </p>
      </header>

      <ul class="ul gap-4">
        {#each plans as plan (plan.name)}
          <li>
            <PricingCard
              name={plan.name}
              price={plan.price}
              features={plan.features}
              callToActionLabel={plan.callToActionLabel}
              selected={selectedPlan === plan.name}
              onPlanSelect={() => {
                selectedPlan = plan.name;
              }}
            />
          </li>
        {/each}
      </ul>
    </div>
  </Container>
</section>

<style>
  .example-grid {
    display: grid;
  }

  .header {
    display: grid;
    max-inline-size: 60ch;
  }

  .h2 {
    margin: 0;
  }

  .ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    align-items: start;
  }
</style>
