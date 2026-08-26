"""Extract bldg:Building lod0RoofEdge footprints + measuredHeight from
PLATEAU CityGML (EPSG:6697 — posList is lat lon [alt]) into one GeoJSON
FeatureCollection (lon lat), for trajectory-viz build_buildings.py.

Usage:
    python scripts/citygml_to_geojson.py "path/udx/bldg/533944*_bldg_*.gml" out.geojson
    python scripts/build_buildings.py --city <name> --plateau-geojson out.geojson \
        --bbox W S E N --out output/viz/buildings/<name>.bin

PLATEAU CityGML zips per city: https://www.geospatial.jp/ckan/dataset/plateau
(e.g. plateau-13203-musashino-shi-2023 for Kichijoji). bldg files are per
1-km mesh; pick mesh codes covering your bbox to avoid parsing the whole city.
"""
import json, sys
import xml.etree.ElementTree as ET
from glob import glob

NS_BLDG = "{http://www.opengis.net/citygml/building/2.0}"
NS_GML = "{http://www.opengis.net/gml}"

def rings_from_poslists(elem):
    """All linear rings under elem: posList 'lat lon alt ...' -> [(lon,lat),...]."""
    rings = []
    for pl in elem.iter(f"{NS_GML}posList"):
        vals = [float(v) for v in pl.text.split()]
        dim = 3 if len(vals) % 3 == 0 else 2
        ring = [(vals[i+1], vals[i]) for i in range(0, len(vals), dim)]
        if len(ring) >= 4:
            rings.append(ring)
    return rings

features = []
for path in sorted(glob(sys.argv[1])):
    n_before = len(features)
    for _, b in filter(lambda e: e[1].tag == f"{NS_BLDG}Building",
                       ET.iterparse(path, events=("end",))):
        mh = b.find(f"{NS_BLDG}measuredHeight")
        height = float(mh.text) if mh is not None and mh.text else None
        roof = b.find(f"{NS_BLDG}lod0RoofEdge")
        if roof is None:
            roof = b.find(f"{NS_BLDG}lod0FootPrint")
        if roof is None:
            b.clear(); continue
        rings = rings_from_poslists(roof)
        if not rings:
            b.clear(); continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [
                [[lon, lat] for lon, lat in ring] for ring in rings]},
            "properties": {"measuredHeight": height},
        })
        b.clear()
    print(f"[{path.split('/')[-1]}] +{len(features)-n_before} buildings", file=sys.stderr)

print(f"total {len(features)} buildings", file=sys.stderr)
json.dump({"type": "FeatureCollection", "features": features}, open(sys.argv[2], "w"))
