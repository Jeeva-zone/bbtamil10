/**
 * App controller: wires the catalogue to the player and the UI.
 *
 * The same module drives index.html (player + channel list) and player.html
 * (player only) — list-specific bits are skipped when their container is absent.
 */
import { loadCatalogue } from './data.js';
import { Player, PlayerState } from './player.js';
import { el, qs, copyText, relativeTime, absTime } from './util.js';

const REFRESH_MS = 30 * 60 * 1000;

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  volumeOn: 'M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  volumeOff: 'M3 10v4h4l5 4V6L7 10H3zm16.5 2 2.5 2.5-1.4 1.4L18 13.4l-2.6 2.5-1.4-1.4L16.6 12 14 9.5l1.4-1.4L18 10.6l2.6-2.5 1.4 1.4z',
  fullscreen: 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z',
  pip: 'M3 5h18v14H3V5zm2 2v10h14V7H5zm7 4h6v5h-6v-5z',
  retry: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  external: 'M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3zM5 5h5v2H7v10h10v-3h2v5H5V5z',
  copy: 'M9 3h9v13h-2V5H9V3zm-3 4h9v14H6V7z',
  live: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0-6a10 10 0 0 0-7.1 2.9l1.4 1.4A8 8 0 0 1 12 4a8 8 0 0 1 5.7 2.3l1.4-1.4A10 10 0 0 0 12 2z',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function button(id, iconName, label) {
  return el('button', { id, class: 'ctl', type: 'button', title: label, 'aria-label': label }, [icon(iconName)]);
}

/**
 * Reachability dot. Deliberately worded as "reachable", not "live": the scheduled
 * health check only proves the address still answers. A Twitch channel page
 * returns 200 whether or not anyone is broadcasting.
 */
function reachDot(stream) {
  const status = stream.status || 'unknown';
  const titles = {
    reachable: 'Address responds — this does not mean the stream is live right now',
    unreachable: 'Address did not respond to the last check',
    unknown: 'Not checked yet',
  };
  const label = { reachable: 'reachable', unreachable: 'unreachable', unknown: 'not checked' }[status] || 'not checked';
  return el('span', {
    class: `reach-dot reach-${status}`,
    title: titles[status] || titles.unknown,
    role: 'img',
    'aria-label': label,
  });
}

class App {
  constructor() {
    this.catalog = null;
    this.selected = null;
    this.filter = 'all';

    this.video = qs('#video');
    this.iframe = qs('#iframe');
    this.stage = qs('#stage');
    this.list = qs('#stream-list');
    this.overlay = qs('#overlay');
    this.overlayTitle = qs('#overlay-title');
    this.overlayMessage = qs('#overlay-message');
    this.pill = qs('#status-pill');

    this.player = new Player({
      video: this.video,
      iframe: this.iframe,
      onState: (state, detail) => this.onPlayerState(state, detail),
    });

    this.buildControls();
    this.wireEvents();
    this.load();
  }

  buildControls() {
    const bar = qs('#controls');
    if (!bar) return;
    // Playback controls are the browser's own (most reliable for live HLS, and
    // they bring fullscreen + picture-in-picture for free). This bar only adds
    // what native controls do not offer.
    bar.append(
      button('live-btn', 'live', 'Jump to the live edge'),
      button('retry-btn', 'retry', 'Reload this stream'),
      button('copy-btn', 'copy', 'Copy a share link'),
      button('open-btn', 'external', 'Open in a new tab'),
    );
  }

  wireEvents() {
    qs('#play-btn')?.addEventListener('click', () => this.togglePlay());
    qs('#mute-btn')?.addEventListener('click', () => this.toggleMute());
    qs('#volume')?.addEventListener('input', (event) => {
      this.video.volume = Number(event.target.value);
      this.video.muted = this.video.volume === 0;
      this.syncMuteIcon();
    });
    qs('#live-btn')?.addEventListener('click', () => this.player.seekToLiveEdge());
    qs('#fs-btn')?.addEventListener('click', () => this.toggleFullscreen());
    qs('#retry-btn')?.addEventListener('click', () => this.player.retry());
    qs('#pip-btn')?.addEventListener('click', () => this.togglePip());
    qs('#copy-btn')?.addEventListener('click', () => this.copyShareLink());
    qs('#open-btn')?.addEventListener('click', () => {
      if (this.selected) window.open(this.selected.url, '_blank', 'noopener');
    });
    qs('#retry-overlay')?.addEventListener('click', () => this.player.retry());

    this.video.addEventListener('click', () => this.togglePlay());
    document.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.player.pause();
    });
  }

  onKey(event) {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const keys = {
      ' ': () => this.togglePlay(),
      k: () => this.togglePlay(),
      m: () => this.toggleMute(),
      f: () => this.toggleFullscreen(),
      r: () => this.player.retry(),
      ArrowRight: () => this.step(1),
      ArrowLeft: () => this.step(-1),
    };
    const handler = keys[event.key];
    if (handler) {
      event.preventDefault();
      handler();
    }
  }

  async load({ initial = true } = {}) {
    try {
      const previousId = this.selected?.id;
      this.catalog = await loadCatalogue();
      this.renderHeader();
      this.renderList();

      if (initial) {
        this.pickInitialStream();
        return;
      }

      // Refresh in place: keep playing the current stream unless it disappeared.
      const stillThere = this.catalog.streams.some((s) => s.id === previousId);
      if (stillThere) this.select(previousId, { push: false, play: false });
      else this.pickInitialStream();
    } catch (error) {
      this.showBanner(`Could not load the stream list. ${error.message}`);
      this.onPlayerState(PlayerState.ERROR, { message: error.message });
    }
  }

  renderHeader() {
    const { show, tagline, updated } = this.catalog;
    if (qs('#show-title')) qs('#show-title').textContent = show;
    if (qs('#show-tagline')) qs('#show-tagline').textContent = tagline;
    if (qs('#updated-at')) {
      qs('#updated-at').textContent = updated ? `Updated ${relativeTime(updated)}` : '';
      qs('#updated-at').title = absTime(updated);
    }
    document.title = `${show} — Live`;
  }

  renderList() {
    if (!this.list) return;
    this.list.replaceChildren();

    const platforms = [...new Set(this.catalog.streams.map((s) => s.platform))];
    const filterBar = qs('#filter-bar');
    if (filterBar && platforms.length > 1) {
      filterBar.replaceChildren(
        this.filterChip('all', 'All'),
        ...platforms.map((platform) => this.filterChip(platform, platform)),
      );
    }

    const visible = this.catalog.streams.filter((s) => this.filter === 'all' || s.platform === this.filter);
    const empty = qs('#empty-state');
    if (empty) empty.hidden = visible.length > 0;

    visible.forEach((stream, index) => {
      const item = el(
        'button',
        {
          class: 'stream-item',
          type: 'button',
          dataset: { id: stream.id },
          onclick: () => this.select(stream.id),
        },
        [
          el('span', { class: 'stream-index', text: String(index + 1).padStart(2, '0') }),
          el('span', { class: 'stream-body' }, [
            el('span', { class: 'stream-name', text: stream.name }),
            el('span', { class: 'stream-meta' }, [
              reachDot(stream),
              el('span', { class: `badge badge-${stream.platformKey}`, text: stream.platform }),
              stream.quality ? el('span', { class: 'muted', text: stream.quality }) : null,
              stream.language ? el('span', { class: 'muted', text: stream.language }) : null,
            ]),
          ]),
        ],
      );
      this.list.append(item);
    });
  }

  filterChip(value, label) {
    return el('button', {
      class: `chip${this.filter === value ? ' is-active' : ''}`,
      type: 'button',
      text: label,
      onclick: () => {
        this.filter = value;
        this.renderList();
      },
    });
  }

  pickInitialStream() {
    const params = new URLSearchParams(location.search);
    const wanted = params.get('s') || params.get('stream');
    const match =
      this.catalog.streams.find((s) => s.id === wanted) ||
      this.catalog.streams.find((s) => String(this.catalog.streams.indexOf(s) + 1) === wanted) ||
      this.catalog.streams[0];
    if (match) this.select(match.id, { push: false });
  }

  select(id, { push = true, play = true } = {}) {
    const stream = this.catalog?.streams.find((s) => s.id === id);
    if (!stream) return;
    this.selected = stream;

    this.list?.querySelectorAll('.stream-item').forEach((node) => {
      node.classList.toggle('is-active', node.dataset.id === id);
    });

    if (qs('#now-name')) qs('#now-name').textContent = stream.name;
    if (qs('#now-platform')) qs('#now-platform').textContent = stream.platform;
    if (qs('#now-note')) qs('#now-note').textContent = stream.note;

    if (push) {
      const url = new URL(location.href);
      url.searchParams.set('s', id);
      history.replaceState(null, '', url);
    }

    if (play) this.player.play(stream);
  }

  step(direction) {
    if (!this.catalog?.streams.length) return;
    const index = this.catalog.streams.findIndex((s) => s.id === this.selected?.id);
    const next = (index + direction + this.catalog.streams.length) % this.catalog.streams.length;
    this.select(this.catalog.streams[next].id);
  }

  onPlayerState(state, detail) {
    const messages = {
      [PlayerState.LOADING]: detail.reason === 'buffering' ? 'Buffering…' : 'Connecting to the stream…',
      [PlayerState.EMBED]: 'Streaming through the platform player.',
      [PlayerState.PLAYING]: '',
    };

    const label = {
      [PlayerState.LOADING]: 'Loading',
      [PlayerState.PLAYING]: 'Live',
      [PlayerState.EMBED]: 'Embed',
      [PlayerState.ERROR]: 'Offline',
      [PlayerState.IDLE]: 'Idle',
    }[state];

    if (this.pill) {
      this.pill.dataset.state = state;
      this.pill.textContent = label || '';
    }

    const isError = state === PlayerState.ERROR;
    if (this.overlay) {
      this.overlay.hidden = !isError && state !== PlayerState.LOADING;
      this.overlay.classList.toggle('is-error', isError);
    }
    if (this.overlayTitle) {
      this.overlayTitle.textContent = isError ? 'Stream unavailable' : 'Connecting…';
    }
    if (this.overlayMessage) {
      this.overlayMessage.textContent = isError ? detail.message || '' : messages[state] || '';
    }
    if (detail.note && qs('#now-note')) qs('#now-note').textContent = detail.note;

    const playBtn = qs('#play-btn');
    if (playBtn) {
      playBtn.replaceChildren(icon(state === PlayerState.PLAYING ? 'pause' : 'play'));
    }
  }

  togglePlay() {
    if (this.selected?.kind !== 'hls') return;
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (qs('#volume')) qs('#volume').value = this.video.muted ? '0' : String(this.video.volume || 1);
    this.syncMuteIcon();
  }

  syncMuteIcon() {
    const btn = qs('#mute-btn');
    if (btn) btn.replaceChildren(icon(this.video.muted || this.video.volume === 0 ? 'volumeOff' : 'volumeOn'));
  }

  toggleFullscreen() {
    const target = this.stage?.requestFullscreen ? this.stage : this.video;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else target.requestFullscreen?.().catch(() => {});
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      this.showBanner('Picture in picture is not available for this stream.');
    }
  }

  async copyShareLink() {
    if (!this.selected) return;
    const url = new URL(location.href);
    url.searchParams.set('s', this.selected.id);
    const ok = await copyText(url.toString());
    this.showBanner(ok ? 'Link copied to the clipboard.' : 'Could not copy the link.');
  }

  showBanner(message) {
    const banner = qs('#banner');
    if (!banner) return;
    banner.textContent = message;
    banner.hidden = !message;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      banner.hidden = true;
    }, 4000);
  }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  // Refresh the catalogue periodically without interrupting playback.
  setInterval(() => app.load({ initial: false }), REFRESH_MS);
});
