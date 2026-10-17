/** URL schemes a player may load. Everything else renders the unavailable state. */
const ALLOWED_MEDIA_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:', 'blob:']);

/**
 * Whether `src` resolves to a URL whose scheme is `https:`, `http:`, or `blob:`.
 * Relative sources resolve against the document's base URL; a source that does
 * not parse is not playable.
 */
export function isPlayableMediaSource(src: string | undefined): boolean {
  if (src === undefined || src.trim() === '') return false;
  try {
    const base = typeof document === 'undefined' ? undefined : document.baseURI;
    return ALLOWED_MEDIA_PROTOCOLS.has(new URL(src, base).protocol);
  } catch {
    return false;
  }
}

/**
 * Playback state shared by the audio and video players. The owning component
 * binds `element` to its native media element, spreads `handlers` onto it, and
 * renders `MediaControls` from the derived fields.
 */
export class MediaPlayerState {
  element = $state<HTMLMediaElement | null>(null);
  playing = $state(false);
  ended = $state(false);
  waiting = $state(false);
  currentTime = $state(0);
  duration = $state(Number.NaN);
  readonly playable: boolean;
  readonly unavailable: boolean;
  readonly progress: number | undefined;
  #erroredSource = $state<string | undefined>(undefined);
  readonly #getSource: () => string | undefined;

  constructor(getSource: () => string | undefined) {
    this.#getSource = getSource;
    this.playable = $derived(isPlayableMediaSource(this.#getSource()));
    this.unavailable = $derived(!this.playable || this.#erroredSource === this.#getSource());
    this.progress = $derived(
      Number.isFinite(this.duration) && this.duration > 0
        ? Math.max(0, Math.min(1, this.currentTime / this.duration))
        : undefined,
    );
  }

  readonly handlers = {
    onplay: () => {
      this.playing = true;
      this.ended = false;
    },
    onpause: () => {
      this.playing = false;
    },
    onended: () => {
      this.playing = false;
      this.ended = true;
    },
    onwaiting: () => {
      this.waiting = true;
    },
    onplaying: () => {
      this.waiting = false;
    },
    oncanplay: () => {
      this.waiting = false;
    },
    ontimeupdate: () => this.#sync(),
    ondurationchange: () => this.#sync(),
    onloadedmetadata: () => this.#sync(),
    onerror: () => {
      this.#erroredSource = this.#getSource();
      this.playing = false;
      this.waiting = false;
    },
  };

  #sync(): void {
    if (this.element === null) return;
    this.currentTime = this.element.currentTime;
    this.duration = this.element.duration;
  }

  /** Forget playback state when the source changes. */
  reset(): void {
    this.playing = false;
    this.ended = false;
    this.waiting = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
  }

  play = (): void => {
    if (this.element === null || this.unavailable) return;
    // play() rejects when the browser blocks or aborts playback; the element's
    // own pause and error events already carry the resulting state.
    void this.element.play()?.catch(() => {});
  };

  pause = (): void => {
    this.element?.pause();
  };

  replay = (): void => {
    if (this.element === null || this.unavailable) return;
    this.element.currentTime = 0;
    this.play();
  };

  seek = (fraction: number): void => {
    if (this.element === null || this.unavailable) return;
    if (!Number.isFinite(this.duration) || this.duration <= 0) return;
    this.element.currentTime = fraction * this.duration;
    this.#sync();
  };
}
