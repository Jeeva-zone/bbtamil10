#!/usr/bin/env python3
"""Ping every stream in data/streams.json and record what came back.

    python3 tools/check_streams.py [--timeout 10]

Writes back into data/streams.json:
    status      "online" | "offline" | "unknown"
    http_status the HTTP code we saw, when there was one
    checked_at  ISO-8601 UTC timestamp

Deliberately forgiving: many of these hosts refuse bots or sit behind a
challenge page, so a 403 is reported as "unknown" rather than a hard failure.
Only connection-level errors and 5xx responses count as offline.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "data" / "streams.json"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; bbtamil10-stream-check/1.0)",
    "Accept": "*/*",
}


def probe(url: str, timeout: int) -> tuple[str, int | None]:
    request = urllib.request.Request(url, headers=HEADERS, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return ("online" if response.status < 400 else "unknown"), response.status
    except urllib.error.HTTPError as error:
        # The host answered - it just did not like the request.
        if error.code >= 500:
            return "offline", error.code
        return "unknown", error.code
    except Exception:
        return "offline", None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=int, default=10)
    args = parser.parse_args()

    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    counts = {"online": 0, "offline": 0, "unknown": 0}

    for stream in catalogue["streams"]:
        status, code = probe(stream["url"], args.timeout)
        stream["status"] = status
        stream["http_status"] = code
        stream["checked_at"] = stamp
        counts[status] += 1
        print(f'{status:<8} {str(code or "-"):<5} {stream["id"]}')

    catalogue["updated"] = stamp
    CATALOGUE.write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"\nchecked {len(catalogue['streams'])} streams: {counts}")


if __name__ == "__main__":
    main()
