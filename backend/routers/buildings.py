"""
Baked-buildings endpoints (Phase 2C).

Serves the per-city PBLD binaries baked by scripts/build_buildings.py from
get_buildings_dir(). The frontend's baked-mode buildings layer fetches
/api/buildings/{city}; the MVT-mode path (Tokyo) never touches this router.
"""

import json
import struct

from fastapi import APIRouter, HTTPException, Path as PathParam
from fastapi.responses import FileResponse

from ..config import get_buildings_dir

router = APIRouter()


def _read_header(path) -> dict:
    """Read just the JSON header of a PBLD file (see backend/buildings_io.py)."""
    with open(path, "rb") as fh:
        if fh.read(4) != b"PBLD":
            raise ValueError("bad magic")
        (hlen,) = struct.unpack("<I", fh.read(4))
        return json.loads(fh.read(hlen).decode("utf-8"))


@router.get("/buildings")
async def list_buildings():
    """List the baked building binaries available on this deployment."""
    bdir = get_buildings_dir()
    cities = []
    if bdir.is_dir():
        for f in sorted(bdir.glob("*.bin")):
            entry = {"city": f.stem, "size_bytes": f.stat().st_size}
            try:
                hdr = _read_header(f)
                entry["n_buildings"] = hdr.get("n_buildings")
                entry["synthesized"] = hdr.get("heights_synthesized", False)
                entry["source"] = hdr.get("source")
            except Exception:
                entry["error"] = "unreadable header"
            cities.append(entry)
    return {"cities": cities}


@router.get("/buildings/{city}")
async def get_city_buildings(
    city: str = PathParam(pattern="^[a-z_]+$"),
):
    """Serve one city's PBLD binary. The city pattern blocks path traversal."""
    path = get_buildings_dir() / f"{city}.bin"
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"No baked buildings for '{city}'.")
    # no-cache = always revalidate, NOT never-cache: FileResponse sends
    # ETag/Last-Modified, so unchanged bins cost a 304. The previous
    # "max-age=86400, immutable" pinned stale bins for a day across
    # re-bakes — browsers skip revalidation entirely for immutable.
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Cache-Control": "no-cache"},
    )
