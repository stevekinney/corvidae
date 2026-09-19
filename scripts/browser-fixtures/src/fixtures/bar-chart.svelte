<script lang="ts">
  import { BarChart } from '@corvidae/cinder';

  const planData = [
    { plan: 'Starter', active: 120, invited: 42 },
    { plan: 'Team', active: 210, invited: 76 },
    { plan: 'Enterprise', active: 92, invited: 28 },
  ];
  const planSeries = [
    { id: 'active', label: 'Active users', valueKey: 'active' },
    { id: 'invited', label: 'Invited users', valueKey: 'invited' },
  ];
  const severityData = [
    { severity: 'Critical escalation', current: 8, previous: 10 },
    { severity: 'High', current: 18, previous: 22 },
    { severity: 'Medium', current: 41, previous: 39 },
  ];
  const severitySeries = [
    { id: 'current', label: 'Current', valueKey: 'current' },
    { id: 'previous', label: 'Previous', valueKey: 'previous' },
  ];
</script>

<div id="example-mount-bar-chart">
  <BarChart
    label="Plan usage"
    data={planData}
    categoryKey="plan"
    series={planSeries}
    dataTableVisibility="visible"
  />
  <BarChart
    label="Incidents by severity"
    data={severityData}
    categoryKey="severity"
    series={severitySeries}
    orientation="horizontal"
  />
</div>
<div id="example-mount-loading">
  <BarChart label="Loading users" loading data={[]} categoryKey="plan" series={[]} />
</div>
