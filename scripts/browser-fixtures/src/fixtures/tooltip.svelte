<script lang="ts">
  import { Button, Tooltip } from '@corvidae/cinder';
</script>

<section aria-label="Overview preview">
  <div id="overview-mount-basic" data-example-preview-ready="">
    <Tooltip text="This is a helpful explanation."
      ><Button variant="secondary">Hover me</Button></Tooltip
    >
    <div style="transform: translate3d(32px, 0, 0); padding: 1rem;">
      <div
        data-testid="transformed-scroll-container"
        style="overflow: auto; width: 28rem; height: 18rem; padding: 1.5rem;"
      >
        <div style="width: 48rem; height: 30rem; padding-top: 10rem; padding-left: 12rem;">
          <Tooltip text="Transformed ancestor tooltip anchor" placement="bottom"
            ><span data-testid="transformed-tooltip-trigger"
              ><Button variant="secondary">Hover for anchored tooltip</Button></span
            ></Tooltip
          >
        </div>
      </div>
    </div>
  </div>
</section>
