<script lang="ts">
  import { AreaChart } from '@repo/cinder';

  const series = [
    {
      id: 'usage',
      label: 'Usage',
      data: [
        { x: 'Jan', y: 44 },
        { x: 'Feb', y: 61 },
        { x: 'Mar', y: 79 },
      ],
    },
  ];
</script>

<div id="example-mount-area-chart">
  <AreaChart label="Product usage" {series} tooltip />
</div>
<div id="example-mount-loading">
  <AreaChart label="Loading usage" loading series={[]} />
</div>
