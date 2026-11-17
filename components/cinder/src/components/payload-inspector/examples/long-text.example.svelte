<script lang="ts" module>
  export const title = 'Long text';
  export const description =
    'Text longer than two lines clamps with Show all and is never squeezed into a grid column. A payload over 1 KB adds its size to the count, and the JSON view keeps the stored text with its \\n escapes.';
</script>

<script lang="ts">
  import { PayloadInspector } from '@lostgradient/cinder';
  const message = [
    'Hi, the parcel for order 4471 arrived on Monday and the box was crushed on one corner.',
    'The lamp inside is cracked along the base and the shade is bent, so I cannot use it as it is.',
    'I took photos of the box and the lamp before I opened anything else, and I can send them on if that helps.',
    'I would rather have a refund than a replacement, because the same carrier would deliver the replacement.',
    'Please tell me what you need from me, and how long the refund takes once you have it.',
    'Thank you for looking at this so quickly, I know it is a busy week for you.',
  ].join('\n');
  const payload = { orderId: 4471, message: message.repeat(3) };
</script>

<PayloadInspector value={payload} label="Input" />
