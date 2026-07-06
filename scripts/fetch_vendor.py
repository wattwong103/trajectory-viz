"""
Fetch the deck.gl UMD bundle for the single-HTML export (Phase 2D).

Run once per machine; the export itself never touches the network. The bundle
is written to scripts/vendor/deck.gl.min.js (gitignored) and its SHA-256 is
verified against the pin below so a compromised CDN can't slip in a payload.

    python scripts/fetch_vendor.py

deck.gl 9.x ships a self-contained UMD build at dist.min.js that exposes the
`deck` global with TripsLayer, PolygonLayer, HeatmapLayer, ScatterplotLayer,
LightingEffect — everything export_template.html needs.
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
OUT = VENDOR_DIR / "deck.gl.min.js"

# deck.gl 9.0.38 UMD bundle from the npm CDN. Pin both URL and hash.
# To bump: change URL, run with --update to print the new hash, paste it here.
URL = "https://cdn.jsdelivr.net/npm/deck.gl@9.0.38/dist.min.js"
SHA256 = "PLACEHOLDER_RUN_WITH_UPDATE"


def main() -> None:
    update = "--update" in sys.argv
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[fetch] {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": "trajectory-viz-fetch"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (pinned host)
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    print(f"[sha256] {digest}  ({len(data)/1024/1024:.2f} MB)")

    if update:
        print(f"\nUpdate SHA256 in {Path(__file__).name} to:\n    SHA256 = \"{digest}\"")
        OUT.write_bytes(data)
        print(f"[write] {OUT} (hash NOT verified — --update mode)")
        return

    if SHA256 == "PLACEHOLDER_RUN_WITH_UPDATE":
        print("\n[ERROR] No pinned SHA256 yet. Run once with --update, paste the "
              "printed hash into fetch_vendor.py, then re-run without --update.")
        sys.exit(2)
    if digest != SHA256:
        print(f"\n[ERROR] SHA-256 mismatch!\n  expected {SHA256}\n  got      {digest}")
        sys.exit(1)
    OUT.write_bytes(data)
    print(f"[write] {OUT} — verified. Export is ready.")


if __name__ == "__main__":
    main()
