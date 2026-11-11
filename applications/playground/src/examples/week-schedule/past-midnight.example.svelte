<script lang="ts" module>
  export const title = 'A window that crosses midnight';
  export const description =
    'Set endsNextDay when the window ends after midnight. The range still reads on one line.';
</script>

<script lang="ts">
  import { WeekSchedule } from '@lostgradient/cinder';
</script>

<WeekSchedule
  label="Late night"
  days={[
    {
      day: 'Fri',
      start: '10:00 pm',
      end: '2:00 am',
      endsNextDay: true,
      description: 'Late-night menu',
    },
    {
      day: 'Sat',
      start: '10:00 pm',
      end: '2:00 am',
      endsNextDay: true,
      description: 'Late-night menu',
    },
  ]}
/>
