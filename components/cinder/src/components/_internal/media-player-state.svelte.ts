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
  muted = $state(false);
  readonly playable: boolean;
  readonly unavailable: boolean;
  readonly progress: number | undefined;
  #erroredSource = $state<string | undefined>(undefined);
  // A position asked for before the length is known, applied once `loadedmetadata` fires.
  #pendingTime: number | undefined = undefined;
  readonly #getSource: () => string | undefined;
  readonly #onTimeChange: ((seconds: number) => void) | undefined;

  /**
   * `onTimeChange` hears every position the element reports, except while a position asked for
   * before the length was known still waits to be applied, so the held position is not overwritten.
   */
  constructor(getSource: () => string | undefined, onTimeChange?: (seconds: number) => void) {
    this.#getSource = getSource;
    this.#onTimeChange = onTimeChange;
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
    onloadedmetadata: () => {
      this.#applyPendingTime();
      this.#sync();
    },
    // Mute can change outside the controls (a browser menu, a script), so the element is the
    // source of truth and the toggle only asks it.
    onvolumechange: () => {
      if (this.element !== null) this.muted = this.element.muted;
    },
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
    if (this.#pendingTime === undefined) this.#onTimeChange?.(this.currentTime);
  }

  #applyPendingTime(): void {
    const pending = this.#pendingTime;
    if (pending === undefined || this.element === null) return;
    const duration = this.element.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    this.#pendingTime = undefined;
    this.element.currentTime = Math.min(pending, duration);
  }

  /** Forget playback state when the source changes. */
  reset(): void {
    this.playing = false;
    this.ended = false;
    this.waiting = false;
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.#pendingTime = undefined;
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

  toggleMute = (): void => {
    if (this.element === null || this.unavailable) return;
    this.element.muted = !this.element.muted;
  };

  seek = (fraction: number): void => {
    if (this.element === null || this.unavailable) return;
    if (!Number.isFinite(this.duration) || this.duration <= 0) return;
    this.element.currentTime = fraction * this.duration;
    this.#sync();
  };

  /**
   * Moves to `seconds`, clamped to the length. Before the length is known the position is held
   * and applied once `loadedmetadata` fires.
   */
  seekTo = (seconds: number): void => {
    if (this.unavailable || !Number.isFinite(seconds)) return;
    const target = Math.max(0, seconds);
    if (this.element === null || !Number.isFinite(this.duration) || this.duration <= 0) {
      this.#pendingTime = target;
      return;
    }
    this.element.currentTime = Math.min(target, this.duration);
    this.#sync();
  };
}
