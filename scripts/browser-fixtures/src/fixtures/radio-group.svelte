<script lang="ts">
  import { RadioGroup } from '@corvidae/cinder';

  let plan = $state('pro');
</script>

<RadioGroup name="plan" label="Pricing tier" bind:value={plan}>
  <RadioGroup.Option id="plan-free" value="free" label="Free — for individuals exploring Cinder" />
  <RadioGroup.Option
    id="plan-pro"
    value="pro"
    label="Pro — small teams, includes private support"
  />
  <RadioGroup.Option
    id="plan-team"
    value="team"
    label="Team — SSO, audit logs, role-based access"
  />
</RadioGroup>
