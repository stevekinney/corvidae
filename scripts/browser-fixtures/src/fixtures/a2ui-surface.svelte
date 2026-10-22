<script lang="ts">
  import { A2uiSurface, type A2uiComponent } from '@lostgradient/chat';

  // Three Modals: one opened by a Button trigger, as A2UI's own modal example
  // does; one whose trigger is plain Text, which the renderer wraps in a
  // button; and one whose trigger is a CheckBox, which renders as itself with
  // an Open button beside it.
  const components: A2uiComponent[] = [
    { id: 'root', component: 'Column', children: ['title', 'details', 'terms', 'consent'] },
    { id: 'title', component: 'Text', text: 'Order summary', variant: 'h2' },
    { id: 'details', component: 'Modal', trigger: 'details-button', content: 'details-content' },
    {
      id: 'details-button',
      component: 'Button',
      child: 'details-label',
      action: { event: { name: 'open' } },
    },
    { id: 'details-label', component: 'Text', text: 'Show details' },
    { id: 'details-content', component: 'Column', children: ['details-heading', 'details-body'] },
    { id: 'details-heading', component: 'Text', text: 'Shipping details', variant: 'h3' },
    { id: 'details-body', component: 'Text', text: 'Ships in two business days.' },
    { id: 'terms', component: 'Modal', trigger: 'terms-label', content: 'terms-body' },
    { id: 'terms-label', component: 'Text', text: 'Read the terms' },
    { id: 'terms-body', component: 'Text', text: 'Returns are accepted within thirty days.' },
    { id: 'consent', component: 'Modal', trigger: 'consent-box', content: 'consent-body' },
    { id: 'consent-box', component: 'CheckBox', label: 'Email me updates', value: false },
    { id: 'consent-body', component: 'Text', text: 'We send at most one email a month.' },
  ];
</script>

<div id="fixture-a2ui-surface" style="max-inline-size: 40rem;">
  <A2uiSurface surfaceId="fixture-surface" {components} />
</div>
