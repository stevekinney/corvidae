<script lang="ts">
  import { FormField, FormSection, Input, Toggle } from '@lostgradient/cinder';

  let displayName = $state('');
  let email = $state('');
  let publicProfile = $state(true);
  let marketingEmails = $state(false);
</script>

<div style="display: flex; flex-direction: column; gap: 2rem;">
  <FormSection
    heading="Account"
    headingLevel={2}
    description="Update your display name and email address."
    columns={2}
  >
    <FormField id="display-name" label="Display name">
      <Input id="display-name" bind:value={displayName} placeholder="Jane Smith" />
    </FormField>
    <FormField id="account-email" label="Email address">
      <Input id="account-email" bind:value={email} type="email" placeholder="jane@example.com" />
    </FormField>
  </FormSection>

  <FormSection
    heading="Privacy"
    headingLevel={2}
    description="Control who can see your profile and what communications you receive."
  >
    <Toggle id="public-profile" bind:checked={publicProfile} label="Public profile" />
    <Toggle id="marketing-emails" bind:checked={marketingEmails} label="Marketing emails" />
  </FormSection>
</div>
