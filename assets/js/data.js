/**
 * Stream catalogue: loading, normalising and platform detection.
 *
 * streams.json is the single source of truth. Everything the player needs is
 * derived here so the UI and the player never have to guess.
 */
import { embedParent } from './util.js';

export const PLATFORM_LABELS = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  okru: 'OK.ru',
  hls: 'HLS',
  dailymotion: 'Dailymotion',
  web: 'Web',
};

/** Identify the platform from the URL alone. */
export function detectPlatform(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('.m3u8')) return 'hls';
  if (value.includes('twitch.tv')) return 'twitch';
  if (value.includes('youtube.com') || value.includes('youtu.be')) return 'youtube';
  if (value.includes('ok.ru')) return 'okru';
  if (value.includes('dailymotion.com')) return 'dailymotion';
  return 'web';
}

/**
 * Playback strategy for a stream: 'hls' plays in <video>, 'iframe' in an iframe.
 * An explicit `type` in the catalogue wins; otherwise an .m3u8 means HLS.
 */
export function kindOf(stream) {
  if (stream.type === 'hls' || stream.type === 'iframe') return stream.type;
  return detectPlatform(stream.url) === 'hls' ? 'hls' : 'iframe';
}

function youtubeId(url) {
  const patterns = [/[?&]v=([\w-]{6,})/, /youtu\.be\/([\w-]{6,})/, /\/embed\/([\w-]{6,})/, /\/live\/([\w-]{6,})/];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function twitchChannel(stream) {
  if (stream.channel) return String(stream.channel).trim();
  const match = String(stream.url || '').match(/twitch\.tv\/(?:videos\/)?([\w-]+)/i);
  return match ? match[1] : null;
}

/**
 * Turn a catalogue entry into a playable descriptor.
 * Returns null when the entry cannot be played at all.
 *
 * `kind` is the playback strategy ('hls' or 'iframe'); `platformKey` is which
 * platform it is. They are deliberately separate: a Twitch channel is still an
 * iframe, but it needs a Twitch-shaped embed URL with the correct `parent`.
 */
export function toPlayable(stream) {
  const url = String(stream.url || '').trim();
  if (!url) return null;

  const platformKey = detectPlatform(url);
  const kind = kindOf(stream);

  const base = {
    id: stream.id || url,
    name: stream.name || PLATFORM_LABELS[platformKey] || 'Stream',
    platform: stream.platform || PLATFORM_LABELS[platformKey] || 'Web',
    platformKey,
    kind,
    url,
    quality: stream.quality || '',
    language: stream.language || '',
    status: stream.status || 'unknown',
    note: stream.note || '',
  };

  if (kind === 'hls') {
    return { ...base, embedUrl: url };
  }

  // Everything below renders in an iframe, but each platform wants a specific URL.
  if (platformKey === 'twitch') {
    const channel = twitchChannel(stream);
    if (!channel) return { ...base, embedUrl: stream.embedUrl || url };
    return {
      ...base,
      channel,
      embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(embedParent())}&autoplay=true&muted=false`,
      url: `https://www.twitch.tv/${channel}`,
    };
  }

  if (platformKey === 'youtube') {
    const id = youtubeId(url);
    if (!id) return { ...base, embedUrl: stream.embedUrl || url };
    return {
      ...base,
      embedUrl: `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0`,
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (platformKey === 'okru') {
    const embed = url.includes('/videoembed/')
      ? url
      : url.replace(/ok\.ru\/(?:video|live)\//, 'ok.ru/videoembed/');
    return { ...base, embedUrl: embed };
  }

  return { ...base, embedUrl: stream.embedUrl || url };
}

export function normalizeCatalogue(raw) {
  const list = Array.isArray(raw) ? raw : raw?.streams;
  if (!Array.isArray(list)) throw new Error('streams.json has no "streams" array');

  const seen = new Set();
  const streams = [];
  for (const entry of list) {
    const playable = toPlayable(entry || {});
    if (!playable || seen.has(playable.id)) continue;
    seen.add(playable.id);
    streams.push(playable);
  }

  return {
    show: raw?.show || 'Live Streams',
    tagline: raw?.tagline || '',
    updated: raw?.updated || raw?.last_updated || null,
    playlist: raw?.playlist || 'playlist.m3u',
    streams,
  };
}

/** Fetch the catalogue, bypassing any HTTP cache. */
export async function loadCatalogue(url = 'data/streams.json') {
  const response = await fetch(`${url}?_=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load streams.json (HTTP ${response.status})`);
  return normalizeCatalogue(await response.json());
}
