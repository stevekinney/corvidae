<script lang="ts">
  import { LineChart } from '@corvidae/cinder';

  const series = [
    {
      id: 'revenue',
      label: 'Revenue',
      data: [
        { x: 'Jan', y: 120 },
        { x: 'Feb', y: 148 },
        { x: 'Mar', y: 172 },
        { x: 'Apr', y: 196 },
      ],
    },
  ];
</script>

<div id="example-mount-line-chart">
  <LineChart label="Monthly recurring revenue" {series} tooltip dataTableVisibility="visible" />
</div>
<div id="example-mount-loading">
  <LineChart label="Loading revenue" loading series={[]} />
</div>
