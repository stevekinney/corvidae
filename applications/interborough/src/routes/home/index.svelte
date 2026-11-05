<script lang="ts">
  /**
   * `/`: Home, the first item in the sidebar. Its heading is Cinder's `visually-hidden` wrapper, so
   * the page shows no heading of its own: the breadcrumb already says "Home", and Home's heading
   * row carries no status or actions (design row 03l). The cards that fill it are built apart from
   * the shell, which only needs the page to exist at `/` so the sidebar and the top bar have
   * somewhere to stand.
   */
  import { VisuallyHidden } from '@lostgradient/cinder';

  import { VIEW_COPY } from '../../app/copy.ts';
</script>

<VisuallyHidden as="h1">{VIEW_COPY.home.label}</VisuallyHidden>
