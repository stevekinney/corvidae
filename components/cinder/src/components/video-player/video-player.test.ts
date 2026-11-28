/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: VideoPlayer } = await import('./video-player.svelte');
const { default: VideoPlayerHarness } = await import('./video-player-harness.test.svelte');
const { default: AudioPlayer } = await import('../audio-player/audio-player.svelte');
const { default: ShareCard } = await import('../share-card/share-card.svelte');

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fullscreenEnabled');
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document, 'exitFullscreen');
});

const SOURCE = 'https://example.com/media/clip';
const LABEL = 'Sample clip';

function mediaElement(container: HTMLElement): HTMLMediaElement {
  return requiredInstance(container.querySelector('video, audio'), HTMLMediaElement);
}

/** The play, pause, and replay button: the player also renders mute and full-screen toggles. */
function primaryButton(container: HTMLElement): HTMLButtonElement {
  return requiredInstance(
    container.querySelector('.cinder-media-controls__button'),
    HTMLButtonElement,
  );
}

async function loadDuration(media: HTMLMediaElement, duration: number, currentTime: number) {
  Object.defineProperty(media, 'duration', { configurable: true, value: duration });
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    writable: true,
    value: currentTime,
  });
  await fireEvent(media, new Event('loadedmetadata'));
}

describe('VideoPlayer', () => {
  test('renders a labelled group with the native element and controls', () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(getByRole('group', { name: LABEL })).toBeTruthy();
    expect(mediaElement(container).getAttribute('src')).toBe(SOURCE);
    expect(mediaElement(container).hasAttribute('controls')).toBe(false);
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
  });

  test('passes the poster to the video element', () => {
    const { container } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      poster: 'https://example.com/p.jpg',
    });
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(
      'https://example.com/p.jpg',
    );
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,unsupported',
    'file:///etc/passwd',
    'ftp://example.com/clip',
    '',
  ])('renders the unavailable state and never loads %p', (src) => {
    const { container, queryByRole } = render(VideoPlayer, { src, label: LABEL });
    expect(mediaElement(container).hasAttribute('src')).toBe(false);
    const button = primaryButton(container);
    expect(button.getAttribute('data-cinder-state')).toBe('unavailable');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(queryByRole('button', { name: 'Mute' })).toBeNull();
  });

  test.each(['https://example.com/clip', 'http://example.com/clip', 'blob:https://example.com/id'])(
    'loads %s',
    (src) => {
      const { container } = render(VideoPlayer, { src, label: LABEL });
      expect(mediaElement(container).getAttribute('src')).toBe(src);
      expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
    },
  );

  test('the play button calls play and the pause button calls pause', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    const calls: string[] = [];
    media.play = () => {
      calls.push('play');
      return Promise.resolve();
    };
    media.pause = () => {
      calls.push('pause');
    };
    await fireEvent.click(primaryButton(container));
    await fireEvent(media, new Event('play'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('playing');
    await fireEvent.click(primaryButton(container));
    expect(calls).toEqual(['play', 'pause']);
  });

  test('a rejected play call does not throw', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    mediaElement(container).play = () => Promise.reject(new Error('blocked'));
    await fireEvent.click(primaryButton(container));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
  });

  test('exposes a seek slider once the duration is known and seeks the element', async () => {
    const { container, getByRole, queryByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
    });
    expect(queryByRole('slider')).toBeNull();
    const media = mediaElement(container);
    await loadDuration(media, 200, 50);
    const slider = requiredInstance(
      getByRole('slider', { name: `${LABEL} position` }),
      HTMLInputElement,
    );
    expect(slider.valueAsNumber).toBeCloseTo(0.25);
    slider.value = '0.5';
    await fireEvent.input(slider);
    expect(media.currentTime).toBeCloseTo(100);
  });

  test('shows the elapsed and total time once the duration is known', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(container.querySelector('.cinder-media-controls__time')).toBeNull();
    const media = mediaElement(container);
    await loadDuration(media, 3725, 65);
    expect(container.querySelector('.cinder-media-controls__time')?.textContent).toBe(
      '1:05 / 1:02:05',
    );
    expect(getByRole('slider').getAttribute('aria-valuetext')).toBe('1:05 of 1:02:05');
  });

  test('the arrow keys move the position five seconds', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await loadDuration(media, 200, 50);
    await fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(media.currentTime).toBeCloseTo(55);
    await fireEvent.keyDown(getByRole('slider'), { key: 'ArrowLeft' });
    expect(media.currentTime).toBeCloseTo(50);
  });

  test('the mute toggle mutes the element and follows its volumechange event', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    const mute = getByRole('button', { name: 'Mute' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(mute);
    expect(media.muted).toBe(true);
    await fireEvent(media, new Event('volumechange'));
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(mute);
    expect(media.muted).toBe(false);
    await fireEvent(media, new Event('volumechange'));
    expect(mute.getAttribute('aria-pressed')).toBe('false');
  });

  test('hides the full-screen toggle where the document cannot go full screen', () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    const { queryByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  test('the full-screen toggle takes the whole player full screen and back', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    const exits: string[] = [];
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: () => {
        exits.push('exit');
        return Promise.resolve();
      },
    });
    const { getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const group = getByRole('group', { name: LABEL });
    const requested: Element[] = [];
    group.requestFullscreen = () => {
      requested.push(group);
      return Promise.resolve();
    };
    const toggle = getByRole('button', { name: 'Full screen' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await fireEvent.click(toggle);
    expect(requested).toEqual([group]);
    fullscreenElement = group;
    await fireEvent(document, new Event('fullscreenchange'));
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(toggle);
    expect(exits).toEqual(['exit']);
    fullscreenElement = null;
    await fireEvent(document, new Event('fullscreenchange'));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  test('replay restarts a finished track', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    let plays = 0;
    media.play = () => {
      plays += 1;
      return Promise.resolve();
    };
    Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 9 });
    await fireEvent(media, new Event('ended'));
    const button = primaryButton(container);
    expect(button.getAttribute('data-cinder-state')).toBe('replay');
    await fireEvent.click(button);
    expect(media.currentTime).toBe(0);
    expect(plays).toBe(1);
  });

  test('shows loading while waiting and unavailable after a media error', async () => {
    const { container } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await fireEvent(media, new Event('waiting'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('loading');
    await fireEvent(media, new Event('canplay'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('paused');
    await fireEvent(media, new Event('error'));
    expect(primaryButton(container).getAttribute('data-cinder-state')).toBe('unavailable');
  });

  test('merges the custom class and forwards rest attributes', () => {
    const { getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      class: 'custom',
      'data-testid': 'player',
    });
    const group = getByRole('group');
    expect(group.classList.contains('cinder-video-player')).toBe(true);
    expect(group.classList.contains('custom')).toBe(true);
    expect(group.getAttribute('data-testid')).toBe('player');
  });
});

/** The focusable controls inside `root`, in document (tab) order, by accessible name. */
function tabOrder(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, input')]
    .filter((element) => element.tabIndex >= 0)
    .map((element) => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '');
}

const MARKER = { time: 12, badge: '1', label: 'Comment 1 at 0:12' };

describe('VideoPlayer markers', () => {
  test('draws a marker named by its label, showing its badge, at its share of the track', async () => {
    const { container, getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      markers: [MARKER],
    });
    await loadDuration(mediaElement(container), 48, 0);
    const markers = container.querySelectorAll('.cinder-video-player__marker');
    expect(markers).toHaveLength(1);
    const marker = getByRole('button', { name: MARKER.label });
    expect(marker.textContent?.trim()).toBe('1');
    expect(marker.style.getPropertyValue('--_cinder-video-player-marker-position')).toBe('25%');
    expect(marker.closest('.cinder-media-controls__track')).not.toBeNull();
  });

  test('clicking a marker seeks to its time', async () => {
    const { container, getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      markers: [MARKER],
    });
    const media = mediaElement(container);
    await loadDuration(media, 48, 0);
    await fireEvent.click(getByRole('button', { name: MARKER.label }));
    expect(media.currentTime).toBe(12);
  });

  test('draws no marker before the length is known, nor one past the end', async () => {
    const { container, queryByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      markers: [MARKER, { time: 60, badge: '2', label: 'Comment 2 at 1:00' }],
    });
    expect(container.querySelector('.cinder-video-player__marker')).toBeNull();
    await loadDuration(mediaElement(container), 48, 0);
    expect(queryByRole('button', { name: MARKER.label })).not.toBeNull();
    expect(queryByRole('button', { name: 'Comment 2 at 1:00' })).toBeNull();
  });

  test('the tab order is the slider, the markers by time, play, back five seconds, then the rest', async () => {
    const { container, getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      markers: [{ time: 30, badge: '2', label: 'Comment 2 at 0:30' }, MARKER],
    });
    await loadDuration(mediaElement(container), 48, 0);
    const order = tabOrder(getByRole('group', { name: LABEL }));
    expect(order.slice(0, 5)).toEqual([
      `${LABEL} position`,
      MARKER.label,
      'Comment 2 at 0:30',
      'Play or pause',
      'Back 5 seconds',
    ]);
    expect(order.slice(5)).toEqual(['Playback speed, normal', 'Mute']);
  });

  test('AudioPlayer keeps play before its seek slider', async () => {
    const { container, getByRole } = render(AudioPlayer, { src: SOURCE, label: LABEL });
    await loadDuration(mediaElement(container), 48, 0);
    const order = tabOrder(getByRole('group', { name: LABEL }));
    expect(order.indexOf('Play or pause')).toBeLessThan(order.indexOf(`${LABEL} position`));
    expect(order.indexOf('Play or pause')).toBeGreaterThanOrEqual(0);
  });
});

describe('VideoPlayer chapters', () => {
  const chapters = [
    { time: 0, title: 'Open board' },
    { time: 12, title: 'Add card' },
  ];

  test('lists each chapter as a button named by its start and title that seeks to it', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL, chapters });
    const media = mediaElement(container);
    await loadDuration(media, 48, 30);
    const group = getByRole('group', { name: 'Chapters' });
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    const addCard = getByRole('button', { name: '0:12 Add card' });
    expect(group.contains(addCard)).toBe(true);
    expect(buttons.some((button) => button.hasAttribute('aria-current'))).toBe(false);
    await fireEvent.click(addCard);
    expect(media.currentTime).toBe(12);
  });

  test('names the group by chaptersLabel', () => {
    const { getByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
      chapters,
      chaptersLabel: 'Steps',
    });
    expect(getByRole('group', { name: 'Steps' })).toBeTruthy();
  });

  test('renders no chapter group without chapters', () => {
    const { queryByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    expect(queryByRole('group', { name: 'Chapters' })).toBeNull();
  });
});

describe('VideoPlayer back five seconds', () => {
  test('moves the position back five seconds, never before the start', async () => {
    const { container, getByRole } = render(VideoPlayer, { src: SOURCE, label: LABEL });
    const media = mediaElement(container);
    await loadDuration(media, 48, 12);
    const back = getByRole('button', { name: 'Back 5 seconds' });
    await fireEvent.click(back);
    expect(media.currentTime).toBe(7);
    media.currentTime = 3;
    await fireEvent(media, new Event('timeupdate'));
    await fireEvent.click(back);
    expect(media.currentTime).toBe(0);
  });

  test('AudioPlayer and ShareCard render no back button', () => {
    const audio = render(AudioPlayer, { src: SOURCE, label: LABEL });
    expect(audio.queryByRole('button', { name: 'Back 5 seconds' })).toBeNull();
    audio.unmount();
    const share = render(ShareCard, { value: 'https://example.com/share/abc' });
    expect(share.queryByRole('button', { name: 'Back 5 seconds' })).toBeNull();
  });
});

describe('VideoPlayer playback speed', () => {
  test('a Dropdown of rates sets the playback rate and renames its trigger', async () => {
    const { container, getByRole, getAllByRole } = render(VideoPlayer, {
      src: SOURCE,
      label: LABEL,
    });
    const media = mediaElement(container);
    const trigger = getByRole('button', { name: 'Playback speed, normal' });
    expect(trigger.textContent?.trim()).toBe('1x');
    expect(trigger.closest('.cinder-dropdown')).not.toBeNull();
    await fireEvent.click(trigger);
    const items = getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['0.5x', '1x', '1.5x', '2x']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    await fireEvent.click(requiredInstance(items[0], HTMLElement));
    expect(media.playbackRate).toBe(0.5);
    const renamed = getByRole('button', { name: 'Playback speed, 0.5 times' });
    expect(renamed.textContent?.trim()).toBe('0.5x');
  });
});

describe('VideoPlayer bound currentTime', () => {
  function harnessMedia(container: HTMLElement): HTMLMediaElement {
    return mediaElement(container);
  }

  test('the bound value follows the element on timeupdate', async () => {
    const bound: number[] = [];
    const { container } = render(VideoPlayerHarness, { onBound: (value) => bound.push(value) });
    const media = harnessMedia(container);
    await loadDuration(media, 48, 0);
    media.currentTime = 9;
    await fireEvent(media, new Event('timeupdate'));
    expect(bound.at(-1)).toBe(9);
  });

  test('writing the bound value seeks, clamped to the length', async () => {
    const bound: number[] = [];
    const { container, rerender } = render(VideoPlayerHarness, {
      onBound: (value) => bound.push(value),
    });
    const media = harnessMedia(container);
    await loadDuration(media, 48, 0);
    await rerender({ requested: 20 });
    expect(media.currentTime).toBe(20);
    await rerender({ requested: 99 });
    expect(media.currentTime).toBe(48);
    expect(bound.at(-1)).toBe(48);
  });

  test('a value written before the metadata loads is applied once it does', async () => {
    const bound: number[] = [];
    const { container, rerender } = render(VideoPlayerHarness, {
      onBound: (value) => bound.push(value),
    });
    const media = harnessMedia(container);
    await rerender({ requested: 20 });
    await fireEvent(media, new Event('timeupdate'));
    expect(bound.at(-1)).toBe(20);
    Object.defineProperty(media, 'duration', { configurable: true, value: 48 });
    await fireEvent(media, new Event('loadedmetadata'));
    expect(media.currentTime).toBe(20);
    expect(bound.at(-1)).toBe(20);
  });

  test('the actions snippet is the last of the controls row and receives the position', async () => {
    const { container, getByTestId } = render(VideoPlayerHarness, {});
    const media = harnessMedia(container);
    await loadDuration(media, 48, 19);
    const row = requiredInstance(
      container.querySelector('.cinder-media-controls__row'),
      HTMLElement,
    );
    const comment = getByTestId('comment');
    expect(row.lastElementChild).toBe(comment);
    expect(comment.textContent).toBe('Comment at 19');
  });
});
