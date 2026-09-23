<script lang="ts">
  import { DonutChart } from '@lostgradient/cinder';

  const data = [
    { id: 'build', label: 'Build', value: 42 },
    { id: 'review', label: 'Review', value: 28 },
    { id: 'test', label: 'Test', value: 18 },
    { id: 'docs', label: 'Docs', value: 12 },
  ];
</script>

<DonutChart label="Workload" {data} centerLabel="Tasks" valueLabels />
