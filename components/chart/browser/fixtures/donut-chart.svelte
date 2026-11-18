<script lang="ts">
  import { default as DonutChart } from '@lostgradient/chart/components/donut-chart/index.ts';

  const data = [
    { id: 'build', label: 'Build', value: 42 },
    { id: 'review', label: 'Review', value: 28 },
    { id: 'test', label: 'Test', value: 18 },
    { id: 'docs', label: 'Docs', value: 12 },
  ];
</script>

<DonutChart label="Workload" {data} centerLabel="Tasks" valueLabels />
