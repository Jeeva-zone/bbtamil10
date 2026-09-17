/**
 * Playback engine.
 *
 * Two strategies, chosen per stream:
 *   - hls   -> <video>, played natively where the browser supports it (Safari,
 *              iOS, Android Chrome) or through hls.js everywhere else (hls.js is
 *              fetched from a CDN only when a stream actually needs it).
 *   - embed -> <iframe> for platforms that only expose an embeddable player
 *              (Twitch, OK.ru, YouTube, generic web players).
 *
 * Emits state changes so the UI can show loading / playing / error without
 * knowing anything about the underlying technology.
 */

const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const MAX_RETRIES = 3;

let hlsLibPromise = null;

function loadHlsLib() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLibPromise) {
    hlsLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = HLS_CDN;
      script.async = true;
      script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js loaded but window.Hls is missing')));
      script.onerror = () => {
        hlsLibPromise = null;
        reject(new Error('Could not load the HLS player library'));
      };
      document.head.append(script);
    });
  }
  return hlsLibPromise;
}

export const PlayerState = {
  IDLE: 'idle',
  LOADING: 'loading',
  PLAYING: 'playing',
  EMBED: 'embed',
  ERROR: 'error',
};

export class Player {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLIFrameElement} opts.iframe
   * @param {(state: string, detail?: object) => void} opts.onState
   */
  constructor({ video, iframe, onState = () => {} }) {
    this.video = video;
    this.iframe = iframe;
    this.onState = onState;
    this.hls = null;
    this.current = null;
    this.retries = 0;
    this.retryTimer = 0;
    this.wantsPlayback = false;

    this.#wireVideo();
  }

  #wireVideo() {
    const { video } = this;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';

    video.addEventListener('playing', () => this.#emit(PlayerState.PLAYING));
    video.addEventListener('waiting', () => {
      if (this.current?.kind === 'hls') this.#emit(PlayerState.LOADING, { reason: 'buffering' });
    });
    video.addEventListener('error', () => {
      if (this.current?.kind === 'hls') {
        this.#fail(this.#describeMediaError(video.error));
      }
    });
  }

  #emit(state, detail = {}) {
    this.onState(state, { stream: this.current, ...detail });
  }

  #describeMediaError(error) {
    if (!error) return 'The stream stopped unexpectedly.';
    switch (error.code) {
      case 1:
        return 'Playback was aborted.';
      case 2:
        return 'The stream could not be downloaded — it may be offline or blocked by CORS.';
      case 3:
        return 'The stream could not be decoded.';
      case 4:
        return 'This stream format is not supported here. Try opening it in a new tab.';
      default:
        return 'The stream could not be played.';
    }
  }

  #fail(message) {
    if (this.retries < MAX_RETRIES && this.wantsPlayback) {
      this.retries += 1;
      const delay = 1000 * this.retries;
      this.#emit(PlayerState.LOADING, { reason: `reconnecting (${this.retries}/${MAX_RETRIES})` });
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.current?.kind === 'hls') this.#startHls(this.current, { isRetry: true });
      }, delay);
      return;
    }
    this.#emit(PlayerState.ERROR, { message });
  }

  /** Load and start a stream descriptor produced by data.js. */
  async play(stream) {
    this.stop({ silent: true });
    this.current = stream;
    this.retries = 0;
    this.wantsPlayback = true;

    if (!stream) {
      this.#emit(PlayerState.IDLE);
      return;
    }

    this.#emit(PlayerState.LOADING, { reason: 'connecting' });

    if (stream.kind === 'hls') {
      await this.#startHls(stream);
      return;
    }

    this.#startEmbed(stream);
  }

  async #startHls(stream, { isRetry = false } = {}) {
    const { video } = this;
    this.#teardownHls();
    this.#teardownEmbed();

    if (!isRetry) {
      video.removeAttribute('src');
      video.load();
    }

    try {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = stream.url;
        await this.#attemptPlay();
        return;
      }

      const Hls = await loadHlsLib();
      if (!Hls.isSupported()) {
        throw new Error('This browser cannot play HLS streams.');
      }

      const hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
        liveSyncDurationCount: 3,
        enableWorker: true,
      });
      this.hls = hls;

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            this.#fail('The stream is not reachable right now.');
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            this.#fail('The stream stopped unexpectedly.');
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.#attemptPlay();
      });

      hls.loadSource(stream.url);
      hls.attachMedia(video);
    } catch (error) {
      this.#emit(PlayerState.ERROR, { message: error.message || 'Could not start this stream.' });
    }
  }

  #startEmbed(stream) {
    this.#teardownHls();
    const { video, iframe } = this;

    video.pause();
    video.removeAttribute('src');
    video.load();
    video.hidden = true;

    iframe.hidden = false;
    iframe.src = stream.embedUrl || stream.url;
    this.#emit(PlayerState.EMBED, { note: 'Playing through the platform player' });
  }

  async #attemptPlay() {
    const { video } = this;
    try {
      await video.play();
    } catch (error) {
      // Browsers block unmuted autoplay until the user interacts with the page.
      if (error?.name === 'NotAllowedError') {
        video.muted = true;
        try {
          await video.play();
          this.#emit(PlayerState.PLAYING, { note: 'Muted — your browser blocked autoplay. Tap the speaker to unmute.' });
          return;
        } catch {
          /* fall through to the generic message below */
        }
      }
      this.#emit(PlayerState.ERROR, {
        message: 'Press play to start — your browser blocked autoplay.',
        recoverable: true,
      });
    }
  }

  /** Re-attempt the current stream (used by the Retry button). */
  async retry() {
    if (!this.current) return;
    this.retries = 0;
    await this.play(this.current);
  }

  pause() {
    this.wantsPlayback = false;
    if (this.current?.kind === 'hls') this.video.pause();
  }

  #teardownHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        /* already gone */
      }
      this.hls = null;
    }
  }

  #teardownEmbed() {
    const { iframe, video } = this;
    if (iframe.src && iframe.src !== 'about:blank') iframe.src = 'about:blank';
    iframe.hidden = true;
    video.hidden = false;
  }

  stop({ silent = false } = {}) {
    this.wantsPlayback = false;
    clearTimeout(this.retryTimer);
    this.#teardownHls();
    this.#teardownEmbed();
    const { video } = this;
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.current = null;
    if (!silent) this.#emit(PlayerState.IDLE);
  }

  get isLive() {
    const { video } = this;
    return Boolean(video.duration === Infinity || (this.hls && this.hls.levels?.length > 0 && video.seekable?.length));
  }

  /** Jump back to the live edge of a live stream. */
  seekToLiveEdge() {
    const { video } = this;
    if (video.seekable && video.seekable.length) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
      video.play().catch(() => {});
    }
  }
}
