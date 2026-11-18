<script lang="ts" module>
  export type DecisionDeckScenario =
    'drag-accept' | 'drag-reject' | 'drag-rtl' | 'last-card' | 'focused-long-title';
</script>

<script lang="ts">
  /**
   * A DecisionDeck brought into one state for a screenshot (COR-2441): the page mounts the deck
   * and this component then drives it the way a person would, with the pointer and the buttons.
   * The decisions made here run with reduced motion on, so the exit copy is never drawn and the
   * frame the screenshot takes is the resting one.
   */
  import { onMount, tick } from 'svelte';

  import DecisionDeck from './decision-deck.svelte';

  let { scenario }: { scenario: DecisionDeckScenario } = $props();

  const items = [
    {
      id: 'receipts',
      eyebrow: 'Receipts',
      title: 'Archive receipts',
      description: 'Move mail from receipts@shop.example to the Receipts label.',
    },
    {
      id: 'digest',
      eyebrow: 'News Weekly',
      title: 'Label the weekly digest',
      description: 'Add the Reading label to mail from digest@news.example.',
    },
    {
      id: 'invoices',
      eyebrow: 'Billing',
      title: 'Star invoices',
      description: 'Star mail whose subject starts with Invoice.',
    },
  ];

  const longItems = [
    {
      id: 'long',
      eyebrow: 'Receipts',
      title:
        'Archive every receipt that arrives from the shop and file it under the quarter in which it was issued',
      description:
        'Move mail from receipts@shop.example to the Receipts label, then add the quarter label so the accountant can find it without asking anyone.',
    },
    ...items.slice(1),
  ];

  const lastItems = [items[0]!];

  const deckItems = $derived(
    scenario === 'focused-long-title' ? longItems : scenario === 'last-card' ? lastItems : items,
  );

  let host: HTMLElement | undefined = $state();

  function pointer(target: EventTarget, type: string, clientX: number, clientY: number): void {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: 'touch',
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  // Held mid-drag: the pointer goes down on the card and moves, and is never released.
  function dragTopCard(distance: number): void {
    const card = host?.querySelector<HTMLElement>('[data-cinder-decision-card][data-depth="0"]');
    if (card === null || card === undefined) return;
    const box = card.getBoundingClientRect();
    const startX = box.left + box.width / 2;
    const startY = box.top + box.height / 2;
    pointer(card, 'pointerdown', startX, startY);
    pointer(window, 'pointermove', startX + distance / 2, startY);
    pointer(window, 'pointermove', startX + distance, startY);
  }

  // The `last-card` decision runs with reduced motion on, so the exit copy is never drawn. The
  // preference is set while the component initialises, before the deck mounts and before any
  // decision, and the deck reads it through an observer that settles in a microtask: the state is
  // reached by order, not by waiting. Everything below runs in microtasks of the mount, ahead of
  // the capture's own round trips, so the frame it takes is always the final one.
  const root = document.documentElement;
  const previous = root.dataset['reducedMotion'];
  // A scenario never changes after mount, so the initial value is the one meant.
  // svelte-ignore state_referenced_locally
  if (scenario === 'last-card') root.dataset['reducedMotion'] = 'on';

  onMount(() => {
    let cancelled = false;

    void (async () => {
      await tick();
      if (scenario === 'drag-accept') dragTopCard(90);
      else if (scenario === 'drag-reject') dragTopCard(-90);
      else if (scenario === 'drag-rtl') dragTopCard(-90);
      else if (scenario === 'focused-long-title') {
        host
          ?.querySelector<HTMLElement>('[data-cinder-decision-card][data-depth="0"]')
          ?.focus({ focusVisible: true } as FocusOptions);
      } else if (scenario === 'last-card') {
        if (cancelled) return;
        host?.querySelector<HTMLElement>('[data-decision-action="accept"]')?.click();
        // The deck moves focus to the empty state after the last decision, and a ring on it is a
        // function of the last input the page saw, which varies. The capture shows the resting
        // state, so focus is released here, in the same task as the decision.
        (document.activeElement as HTMLElement | null)?.blur();
      }
    })();

    return () => {
      cancelled = true;
      if (previous === undefined) delete root.dataset['reducedMotion'];
      else root.dataset['reducedMotion'] = previous;
    };
  });
</script>

<div
  bind:this={host}
  dir={scenario === 'drag-rtl' ? 'rtl' : undefined}
  lang={scenario === 'drag-rtl' ? 'ar' : undefined}
  data-preserve-motion
  data-testid="decision-deck-scenario"
>
  <DecisionDeck label="Review queue" items={deckItems} />
</div>
