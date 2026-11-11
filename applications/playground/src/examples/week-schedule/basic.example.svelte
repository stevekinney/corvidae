<script lang="ts" module>
  export const title = 'A week of windows';
  export const description =
    'One row per day. Today sits on the surface, a live window carries an inverted On now pill, and a time range never breaks inside.';
</script>

<script lang="ts">
  import { WeekSchedule } from '@lostgradient/cinder';
</script>

<WeekSchedule
  label="Happy hour"
  days={[
    { day: 'Mon', start: '2:00 pm', end: '8:00 pm', description: 'Half-price wells' },
    {
      day: 'Tue',
      start: '2:00 pm',
      end: '8:00 pm',
      description: 'Taco and margarita special',
      today: true,
      live: true,
    },
    { day: 'Wed', start: '4:00 pm', end: '7:00 pm', description: 'Draft pints' },
  ]}
/>
