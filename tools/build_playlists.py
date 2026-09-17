#!/usr/bin/env python3
"""Regenerate the M3U playlists from data/streams.json.

    python3 tools/build_playlists.py [--base https://example.com/path]

playlist.m3u      direct stream URLs, for IPTV players that can play them
playlist_web.m3u  the same channels routed through player.html, for players
                  that only understand HTTP pages
"""
from __future__ import annotations

import argparse
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "data" / "streams.json"
DEFAULT_BASE = "https://jeeva-zone.github.io/bbtamil10"

LOGOS = {
    "Twitch": "https://static-cdn.jtvnw.net/ttv-static/404_boxart.jpg",
    "OK.ru": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Odnoklassniki_logo.svg/240px-Odnoklassniki_logo.svg.png",
}


def extinf(stream: dict, group: str) -> str:
    attrs = [
        f'tvg-id="{stream["id"]}"',
        f'tvg-name="{stream["name"]}"',
        f'group-title="{group}"',
    ]
    logo = LOGOS.get(stream.get("platform", ""))
    if logo:
        attrs.append(f'tvg-logo="{logo}"')
    return f'#EXTINF:-1 {" ".join(attrs)},{stream["name"]} ({stream.get("platform", "Web")})'


def build(streams: list[dict], group: str, base: str, web: bool) -> str:
    lines = ["#EXTM3U"]
    for stream in streams:
        lines.append(extinf(stream, group))
        lines.append(f'{base}/player.html?s={stream["id"]}' if web else stream["url"])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=DEFAULT_BASE, help="public base URL of the site")
    args = parser.parse_args()

    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    streams = catalogue["streams"]
    group = catalogue.get("show", "Live")

    targets = {
        ROOT / "playlist.m3u": build(streams, group, args.base, web=False),
        ROOT / "playlist_web.m3u": build(streams, group, args.base, web=True),
    }
    for path, content in targets.items():
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(ROOT)}  ({len(streams)} channels)")


if __name__ == "__main__":
    main()
