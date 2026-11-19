/**
 * Home's Workflow activity band and the activity region (COR-2227, AC7): the fleet feed's frames
 * worded by `FLEET_EVENT_RULES` in the same row shape as Agent activity, the replay read as one
 * window, a kind with no rule in plain words, telemetry left out; the two bands as Home's last
 * region, each with its own loading, empty and failed states, and a band that cannot be read says so
 * in its own place with Try again while the other stays live.
 */
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import Harness from './home-activity.test-harness.svelte';
import {
  ACTIVITY_NOW,
  bureauEnvelope,
  fleetFrame,
  installActivityWorld,
  OLDER,
  REPLAY_COMPLETE_CHUNK,
  TODAY,
  YESTERDAY,
  type ActivityWorld,
} from './home-activity.test-support.ts';

let world: ActivityWorld | undefined;
const previousZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeAll(() => {
  process.env['TZ'] = 'America/Chicago';
});

afterAll(() => {
  process.env['TZ'] = previousZone;
});

beforeEach(() => {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  setSystemTime(new Date(ACTIVITY_NOW));
});

afterEach(() => {
  cleanup();
  world?.restore();
  world = undefined;
  setSystemTime();
});

function open(
  sources: { bureau?: boolean; fleet?: boolean; routed?: boolean } = {},
  prepare: (opened: ActivityWorld) => void = () => {},
) {
  world = installActivityWorld();
  // The bands open their feeds as they mount, so a refusal is set up first.
  prepare(world);
  const { container } = render(Harness, {
    props: {
      ...(sources.bureau === false ? {} : { bureauEvents: world.bureauEvents }),
      ...(sources.fleet === false ? {} : { fleetEvents: world.fleetEvents }),
      routed: sources.routed === true,
    },
  });
  return { world, container };
}

function band(container: HTMLElement, title: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-home-card="${title}"]`);
  if (found === null) throw new Error(`no ${title} band`);
  return found;
}

const workflow = (container: HTMLElement) => band(container, 'Workflow activity');
const agents = (container: HTMLElement) => band(container, 'Agent activity');
const rowsOf = (element: HTMLElement) => [
  ...element.querySelectorAll<HTMLElement>('.cinder-grouped-list-item'),
];
const titlesOf = (element: HTMLElement) =>
  rowsOf(element).map(
    (row) => row.querySelector('.cinder-grouped-list-item__title')?.textContent?.trim() ?? '',
  );

describe('Workflow activity (AC7)', () => {
  test('reads the replay as one window and words each kind by its rule, newest first', async () => {
    const { world, container } = open();
    await waitUntil(() => world.hub.opened('fleet') === 1);
    world.hub.write(
      'fleet',
      fleetFrame('f:1', 'worker:connected', OLDER, { workerId: 'w1', queue: 'default' }),
      fleetFrame('f:2', 'workflow:started', YESTERDAY, {
        workflowId: 'wf-1',
        workflowType: 'Release notes digest',
      }),
      fleetFrame('f:3', 'workflow:failed', TODAY, { workflowId: 'wf-1', error: 'Step 3 threw' }),
    );
    // A replayed frame is never a row of its own: nothing is listed until the replay ends.
    await waitUntil(() => world.fleetEvents.recent().length === 3);
    expect(rowsOf(workflow(container))).toHaveLength(0);
    world.hub.write(
      'fleet',
      // Telemetry is left out of the band.
      fleetFrame('f:4', 'storage:size-reported', TODAY + 1_000, { sizeBytes: 1 }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => rowsOf(workflow(container)).length === 3);
    expect(titlesOf(workflow(container))).toEqual([
      'Run failed',
      'Run started',
      'Worker connected',
    ]);
    const [failed, started, worker] = rowsOf(workflow(container));
    expect(failed?.querySelector('.cinder-status-dot')?.getAttribute('data-cinder-status')).toBe(
      'danger',
    );
    expect(failed?.querySelector('a')?.getAttribute('href')).toBe('/runs/wf-1');
    expect(failed?.querySelector('time')?.textContent).toBe('10:42 AM');
    expect(started?.querySelector('.cinder-status-dot')).toBeNull();
    expect(started?.querySelector('.cinder-grouped-list-item__subtitle')?.textContent?.trim()).toBe(
      'Release notes digest',
    );
    expect(started?.querySelector('time')?.textContent).toBe('Yesterday, 4:12 PM');
    expect(worker?.querySelector('time')?.textContent).toBe('Thu, Oct 29, 4:12 PM');
    expect(worker?.querySelector('a')).toBeNull();
    expect(
      within(workflow(container)).getByRole('list', { name: 'Recent workflow activity' }),
    ).toBeTruthy();
  });

  test('a kind with no rule reads in plain words with its raw kind, and a live frame enters at the top', async () => {
    const { world, container } = open();
    await waitUntil(() => world.hub.opened('fleet') === 1);
    world.hub.write(
      'fleet',
      fleetFrame('f:1', 'realm:state-changed', TODAY, { state: 'active' }),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => rowsOf(workflow(container)).length === 1);
    expect(titlesOf(workflow(container))).toEqual(['Realm state changed']);
    expect(workflow(container).querySelector('code')?.textContent).toBe('realm:state-changed');

    world.hub.write(
      'fleet',
      fleetFrame('f:2', 'worker:disconnected', TODAY + 1_000, { workerId: 'w1' }),
    );
    await waitUntil(() => rowsOf(workflow(container)).length === 2);
    expect(titlesOf(workflow(container))).toEqual(['Worker disconnected', 'Realm state changed']);
    expect(
      rowsOf(workflow(container))[0]?.classList.contains('cinder-grouped-list-item--arriving'),
    ).toBe(true);
  });

  test('both bands share the one Cinder row: GroupedListItem with its icon slot and its time', async () => {
    const { world, container } = open();
    await waitUntil(() => world.hub.opened('fleet') === 1 && world.hub.opened('bureau') === 1);
    world.hub.write('fleet', fleetFrame('f:1', 'workflow:started', TODAY), REPLAY_COMPLETE_CHUNK);
    world.hub.write(
      'bureau',
      'id: b:1\nevent: chat.started\ndata: {"kind":"chat.started","cursor":"b:1","sequence":1,"emittedAtMs":' +
        String(TODAY) +
        ',"payload":{}}\n\n',
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(
      () => rowsOf(workflow(container)).length === 1 && rowsOf(agents(container)).length === 1,
    );
    for (const row of [...rowsOf(workflow(container)), ...rowsOf(agents(container))]) {
      expect(row.tagName).toBe('LI');
      expect(
        row
          .querySelector('.cinder-grouped-list-item__leading')
          ?.getAttribute('data-cinder-leading'),
      ).toBe('icon');
      expect(row.querySelector('.cinder-grouped-list-item__trailing time')).not.toBeNull();
    }
  });
});

describe('the activity region', () => {
  test('holds Workflow activity then Agent activity, each a heading over its placeholders until read', async () => {
    const { world, container } = open();
    const region = container.querySelector('[data-testid="home-activity"]');
    expect(
      [...(region?.querySelectorAll('h2') ?? [])].map((heading) => heading.textContent?.trim()),
    ).toEqual(['Workflow activity', 'Agent activity']);
    for (const element of [workflow(container), agents(container)]) {
      expect(element.querySelectorAll('.cinder-skeleton-grouped-row')).toHaveLength(3);
      expect(element.querySelectorAll('.cinder-skeleton-grouped-leading')).toHaveLength(3);
      expect(element.querySelectorAll('.cinder-skeleton-trailing-bar')).toHaveLength(3);
      // The time bars end before the chevron's column, where the rows' times end.
      expect(
        element.querySelectorAll('.cinder-skeleton-trailing-bar--chevron-column'),
      ).toHaveLength(3);
    }
    // No count, badge, live pill or control beside a heading.
    expect(region?.querySelectorAll('button, a, [role="status"] .cinder-badge')).toHaveLength(0);
    // Each band is its own wrapper's one Section, so Cinder's margin between adjacent Sections
    // never adds to the region's gap (side by side it pushed Agent activity 32px down).
    expect(region?.querySelectorAll('.cinder-section + .cinder-section')).toHaveLength(0);
    expect(
      [...(region?.querySelectorAll('.ib-home__activity-band') ?? [])].map(
        (band) => band.querySelectorAll(':scope > .cinder-section').length,
      ),
    ).toEqual([1, 1]);
    await waitUntil(() => world.hub.opened('fleet') === 1);
  });

  test('each band is empty in its own words, with no action', async () => {
    const { world, container } = open();
    await waitUntil(() => world.hub.opened('fleet') === 1 && world.hub.opened('bureau') === 1);
    world.hub.write('fleet', REPLAY_COMPLETE_CHUNK);
    world.hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => workflow(container).querySelector('.cinder-empty-state-title') !== null);
    await waitUntil(() => agents(container).querySelector('.cinder-empty-state-title') !== null);
    expect(
      workflow(container).querySelector('.cinder-empty-state-title')?.textContent?.trim(),
    ).toBe('No workflow activity yet');
    expect(workflow(container).textContent).toContain(
      'Workflow runs, steps and workers appear here as they happen.',
    );
    expect(agents(container).querySelector('.cinder-empty-state-title')?.textContent?.trim()).toBe(
      'No agent activity yet',
    );
    expect(agents(container).textContent).toContain(
      'Chats, reviews, goals, schedules and hooks appear here as they happen.',
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // Cinder's one empty state, with its own tinted disc around the band's glyph.
    for (const element of [workflow(container), agents(container)]) {
      expect(element.querySelector('.cinder-empty-state')).not.toBeNull();
      expect(element.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
    }
  });

  test('outside the shell, with no feed to read, each band says it has no activity', () => {
    open({ bureau: false, fleet: false });
    const container = document.body;
    expect(
      workflow(container).querySelector('.cinder-empty-state-title')?.textContent?.trim(),
    ).toBe('No workflow activity yet');
    expect(agents(container).querySelector('.cinder-empty-state-title')?.textContent?.trim()).toBe(
      'No agent activity yet',
    );
  });

  test('a band whose feed cannot be read says so in its own place, and Try again reads it', async () => {
    const opened = open({}, (prepared) => {
      prepared.hub.refusals.fleet = 503;
    });
    const { container } = opened;
    await waitUntil(() => opened.world.hub.opened('bureau') === 1);
    opened.world.hub.write('bureau', REPLAY_COMPLETE_CHUNK);
    await waitUntil(
      () => workflow(container).querySelector('[data-testid="home-card-error"]') !== null,
    );
    const failure = workflow(container);
    expect(failure.textContent).toContain('Couldn’t load workflow activity.');
    expect(failure.textContent).toContain('The rest of Home is live.');
    // The other band is not held by this one.
    await waitUntil(() => agents(container).querySelector('.cinder-empty-state-title') !== null);
    expect(agents(container).querySelector('[data-testid="home-card-error"]')).toBeNull();

    const retry = within(failure).getByRole('button', { name: 'Try again' });
    await fireEvent.click(retry);
    await waitUntil(() => opened.world.hub.opened('fleet') === 1);
    expect(workflow(container).querySelector('[data-testid="home-card-error"]')).toBeNull();
    opened.world.hub.write('fleet', REPLAY_COMPLETE_CHUNK);
    await waitUntil(() => workflow(container).querySelector('.cinder-empty-state-title') !== null);
    expect(
      workflow(container).querySelector('.cinder-empty-state-title')?.textContent?.trim(),
    ).toBe('No workflow activity yet');
  });

  test('after Try again, a connection that answers and then drops says so at once', async () => {
    const opened = open({}, (prepared) => {
      prepared.hub.refusals.fleet = 503;
    });
    const { container } = opened;
    const failure = () => workflow(container).querySelector('[data-testid="home-card-error"]');
    await waitUntil(() => failure() !== null);
    const retry = within(workflow(container)).getByRole('button', { name: 'Try again' });
    await fireEvent.click(retry);
    await waitUntil(() => opened.world.hub.opened('fleet') === 1);
    expect(failure()).toBeNull();
    // The feed answers, which starts the source's attempt count again at 0, and then drops
    // before its replay ends: the attempt is 1 again, as it was when Try again was pressed.
    opened.world.hub.write('fleet', 'event: ping\ndata: {"emittedAtMs":0}\n\n');
    await waitUntil(() => opened.world.fleetEvents.reconnectAttempt === 0);
    opened.world.hub.end('fleet');
    await waitUntil(() => opened.world.fleetEvents.reconnectAttempt === 1);
    await waitUntil(() => failure() !== null);
    expect(workflow(container).querySelector('.cinder-skeleton-grouped-row')).toBeNull();
  });
});

describe('the hold across the activity region (F7-39)', () => {
  /** Opens both bands with three rows each and returns each band's list, where its hold sits. */
  async function bothReady(options: { routed?: boolean } = {}) {
    const opened = open(options);
    const { world, container } = opened;
    await waitUntil(() => world.hub.opened('fleet') === 1 && world.hub.opened('bureau') === 1);
    world.hub.write(
      'fleet',
      fleetFrame('f:1', 'workflow:started', OLDER, { workflowId: 'wf-1' }),
      fleetFrame('f:2', 'workflow:started', YESTERDAY, { workflowId: 'wf-2' }),
      fleetFrame('f:3', 'workflow:started', TODAY, { workflowId: 'wf-3' }),
      REPLAY_COMPLETE_CHUNK,
    );
    world.hub.write(
      'bureau',
      bureauEnvelope('b:1', 'chat.started', OLDER),
      bureauEnvelope('b:2', 'chat.started', YESTERDAY),
      bureauEnvelope('b:3', 'chat.started', TODAY),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(
      () => rowsOf(workflow(container)).length === 3 && rowsOf(agents(container)).length === 3,
    );
    const listOf = (element: HTMLElement) => {
      const list = element.querySelector('ul')?.parentElement?.parentElement;
      if (list === null || list === undefined) throw new Error('no list');
      return list;
    };
    const bands = container.querySelector<HTMLElement>('.ib-home__activity-bands');
    if (bands === null) throw new Error('no activity region');
    return {
      ...opened,
      bands,
      workflowList: listOf(workflow(container)),
      agentList: listOf(agents(container)),
      /** Writes a live workflow event, which Workflow activity lists at the top. */
      arrive(cursor: string) {
        world.hub.write(
          'fleet',
          fleetFrame(cursor, 'workflow:completed', ACTIVITY_NOW - 30_000, { workflowId: cursor }),
        );
      },
    };
  }

  const firstWorkflowTitle = (container: HTMLElement) => titlesOf(workflow(container))[0];

  test('stacked, a mouse resting on Agent activity holds Workflow activity too, until it leaves', async () => {
    const { world, container, bands, agentList, arrive } = await bothReady();
    expect(getComputedStyle(bands).display).not.toBe('grid');
    await fireEvent.pointerEnter(agentList, { pointerType: 'mouse' });
    arrive('f:4');
    await waitUntil(() => world.fleetEvents.recent().length === 4);
    await quietFor(20);
    expect(firstWorkflowTitle(container)).toBe('Run started');
    await fireEvent.pointerLeave(agentList, { pointerType: 'mouse' });
    await waitUntil(() => firstWorkflowTitle(container) === 'Run finished');
    expect(rowsOf(workflow(container))).toHaveLength(3);
  });

  test('stacked, a press that began in Agent activity holds Workflow activity until it ends', async () => {
    const { world, container, agentList, arrive } = await bothReady();
    await fireEvent.pointerDown(agentList, { pointerType: 'touch' });
    arrive('f:4');
    await waitUntil(() => world.fleetEvents.recent().length === 4);
    await quietFor(20);
    expect(firstWorkflowTitle(container)).toBe('Run started');
    await fireEvent.pointerUp(window, { pointerType: 'touch' });
    await waitUntil(() => firstWorkflowTitle(container) === 'Run finished');
  });

  test('stacked, focus moving from one band’s list into the other’s keeps both held', async () => {
    const { world, container, workflowList, agentList, arrive } = await bothReady();
    const link = workflowList.querySelector('a');
    if (link === null) throw new Error('no link');
    await fireEvent.focusIn(link);
    arrive('f:4');
    await waitUntil(() => world.fleetEvents.recent().length === 4);
    await quietFor(20);
    const into = agentList.querySelector('li') ?? agentList;
    await fireEvent.focusOut(link, { relatedTarget: into });
    await quietFor(20);
    expect(firstWorkflowTitle(container)).toBe('Run started');
    await fireEvent.focusIn(into);
    await quietFor(20);
    expect(firstWorkflowTitle(container)).toBe('Run started');
    await fireEvent.focusOut(into, { relatedTarget: document.body });
    await waitUntil(() => firstWorkflowTitle(container) === 'Run finished');
  });

  test('stacked, a band’s first window replaces its placeholders while the other band holds', async () => {
    const { world, container } = open();
    await waitUntil(() => world.hub.opened('fleet') === 1 && world.hub.opened('bureau') === 1);
    world.hub.write(
      'bureau',
      bureauEnvelope('b:1', 'chat.started', OLDER),
      bureauEnvelope('b:2', 'chat.started', TODAY),
      REPLAY_COMPLETE_CHUNK,
    );
    await waitUntil(() => rowsOf(agents(container)).length === 2);
    const agentList = agents(container).querySelector('ul')?.parentElement?.parentElement;
    if (agentList === null || agentList === undefined) throw new Error('no list');
    await fireEvent.pointerEnter(agentList, { pointerType: 'mouse' });
    world.hub.write(
      'fleet',
      fleetFrame('f:1', 'workflow:started', TODAY, { workflowId: 'wf-1' }),
      REPLAY_COMPLETE_CHUNK,
    );
    // Never the empty state over a window that has rows: the window is drawn at once.
    await waitUntil(() => rowsOf(workflow(container)).length === 1);
    expect(workflow(container).querySelector('.cinder-empty-state-title')).toBeNull();
    expect(titlesOf(workflow(container))).toEqual(['Run started']);
    await fireEvent.pointerLeave(agentList, { pointerType: 'mouse' });
  });

  test('side by side, each band holds only its own rows', async () => {
    const { world, container, bands, agentList, arrive } = await bothReady();
    // What the region's container query does at 54rem and wider.
    bands.style.display = 'grid';
    await fireEvent.pointerEnter(agentList, { pointerType: 'mouse' });
    arrive('f:4');
    await waitUntil(() => firstWorkflowTitle(container) === 'Run finished');
    expect(world.fleetEvents.recent()).toHaveLength(4);
    await fireEvent.pointerLeave(agentList, { pointerType: 'mouse' });
  });

  describe('following a row’s link tears Home down and writes no state (F7-26)', () => {
    let errors: string[] = [];
    let restoreRemove: (() => void) | undefined;
    const onError = (event: ErrorEvent): void => {
      errors.push(String(event.error ?? event.message));
    };

    beforeEach(() => {
      errors = [];
      router.navigate('/', { replace: true });
      window.addEventListener('error', onError);
      restoreRemove = blurOnRemoval();
    });

    afterEach(() => {
      restoreRemove?.();
      restoreRemove = undefined;
      window.removeEventListener('error', onError);
      router.navigate('/', { replace: true });
    });

    /** Follows `link` (Enter on a link is a click on it), and waits for Home to be gone. */
    async function follow(link: HTMLAnchorElement, container: HTMLElement): Promise<void> {
      try {
        await fireEvent.click(link);
      } catch (error) {
        errors.push(String(error));
      }
      expect(router.pathname).not.toBe('/');
      expect(container.querySelector('[data-home-card]')).toBeNull();
      await quietFor(20);
    }

    test('by a mouse click, side by side, with the pointer and focus on the link', async () => {
      const { container, bands, workflowList } = await bothReady({ routed: true });
      bands.style.display = 'grid';
      const link = workflowList.querySelector('a');
      if (link === null) throw new Error('no link');
      await fireEvent.pointerEnter(workflowList, { pointerType: 'mouse' });
      await fireEvent.pointerDown(link, { pointerType: 'mouse' });
      link.focus();
      await fireEvent.pointerUp(window, { pointerType: 'mouse' });
      await follow(link, container);
      expect(errors).toEqual([]);
    });

    test('by Enter, stacked, with an arrival held by focus alone', async () => {
      const { world, container, workflowList, arrive } = await bothReady({ routed: true });
      const link = workflowList.querySelector('a');
      if (link === null) throw new Error('no link');
      link.focus();
      arrive('f:4');
      await waitUntil(() => world.fleetEvents.recent().length === 4);
      await quietFor(20);
      expect(firstWorkflowTitle(container)).toBe('Run started');
      await follow(link, container);
      expect(errors).toEqual([]);
    });
  });
});

/**
 * Chromium blurs the focused element as it is removed: `blur` and `focusout`, with no related
 * target, fire synchronously inside the `remove()` of an element that holds focus, which for a page
 * leaving is a Svelte block effect tearing it down. happy-dom fires neither, so this does what
 * Chromium does. Returns what restores `Element.prototype.remove`.
 */
function blurOnRemoval(): () => void {
  const own = Object.getOwnPropertyDescriptor(Element.prototype, 'remove');
  const remove = Element.prototype.remove;
  Object.defineProperty(Element.prototype, 'remove', {
    configurable: true,
    writable: true,
    value(this: Element): void {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body && this.contains(focused)) {
        focused.dispatchEvent(new FocusEvent('blur'));
        focused.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      }
      remove.call(this);
    },
  });
  return () => {
    if (own === undefined) Reflect.deleteProperty(Element.prototype, 'remove');
    else Object.defineProperty(Element.prototype, 'remove', own);
  };
}
