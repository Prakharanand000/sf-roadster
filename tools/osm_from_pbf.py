"""OSM inputs for the v2 bake, read from the Geofabrik extract instead of Overpass.

Writes the same Overpass "out geom" JSON that tools/fetch_osm.py caches for v1 (ways with `nodes`
and `geometry`, relations with member geometry, nodes with lat/lon), so the v1 bake logic reads it
unchanged. One file per v1 query: osm_roads, osm_bld_0_0, osm_bridges, osm_landuse, osm_coast,
osm_trees, osm_misc, in geo2.CACHE.

Uses the osmium command-line tool from the conda `bake` env (pyosmium's wheel is blocked where
Windows Smart App Control is on). Run with the analysis venv:
    python tools/osm_from_pbf.py [path/to/norcal-latest.osm.pbf]
"""
import json
import os
import re
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geo2 import AREA, BAKE_CACHE, CACHE  # noqa: E402

BAKE_ENV = os.environ.get("SF_BAKE_ENV", os.path.expanduser(r"~\miniforge3\envs\bake"))
OSMIUM = os.path.join(BAKE_ENV, "Library", "bin", "osmium.exe")
PBF = os.path.join(BAKE_CACHE, "osm", "norcal-latest.osm.pbf")
MARGIN = 0.02   # degrees around the play area, so ways and coastline run past its edge
WORK = os.path.join(CACHE, "work")

HIGHWAYS = ("motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
            "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
            "living_street", "service", "pedestrian")
LEISURE_W = ("park", "garden", "golf_course", "pitch", "playground", "recreation_ground", "nature_reserve",
             "common", "dog_park")
LEISURE_R = ("park", "garden", "golf_course", "recreation_ground", "nature_reserve")
LANDUSE_W = ("grass", "forest", "meadow", "recreation_ground", "cemetery", "village_green", "allotments", "flowerbed")
LANDUSE_R = ("grass", "forest", "meadow", "recreation_ground", "cemetery")
NATURAL_W = ("wood", "scrub", "heath", "grassland", "beach", "sand", "water", "wetland", "bare_rock", "cliff")
NATURAL_R = ("wood", "scrub", "heath", "grassland", "beach", "sand", "water", "wetland")
LANDMARK_NAMES = re.compile("Transamerica|Salesforce Tower|Coit Tower|Ferry Building|Palace of Fine Arts|City Hall|"
                            "Alcatraz|Pier 39|Oracle Park|Ghirardelli|Dragon Gate|Golden Gate Bridge|Painted Ladies|"
                            "Fort Point")


def landuse_way(t):
    return (t.get("leisure") in LEISURE_W or t.get("landuse") in LANDUSE_W or t.get("natural") in NATURAL_W
            or t.get("man_made") in ("pier", "breakwater", "groyne") or "water" in t
            or t.get("amenity") == "parking" or "area:highway" in t
            or (t.get("highway") == "pedestrian" and t.get("area") == "yes") or t.get("place") == "square")


def landuse_rel(t):
    return t.get("leisure") in LEISURE_R or t.get("landuse") in LANDUSE_R or t.get("natural") in NATURAL_R


# name: (osmium tags-filter expressions, way predicate, relation predicate, node predicate, node output)
CATEGORIES = {
    "roads": (["w/highway=" + ",".join(HIGHWAYS)], lambda t: t.get("highway") in HIGHWAYS, None, None, None),
    "bld_0_0": (["w/building", "r/building"], lambda t: "building" in t,
                lambda t: "building" in t and t.get("type") == "multipolygon", None, None),
    "bridges": (["w/bridge", "w/man_made=bridge,tower", "w/bridge:structure"],
                lambda t: ("highway" in t and "bridge" in t) or t.get("man_made") in ("bridge", "tower")
                or "bridge:structure" in t, None, None, None),
    "landuse": (["w/leisure", "w/landuse", "w/natural", "w/man_made=pier,breakwater,groyne", "w/water",
                 "w/amenity=parking", "w/area:highway", "w/highway=pedestrian", "w/place=square",
                 "r/leisure", "r/landuse", "r/natural"], landuse_way, landuse_rel, None, None),
    "coast": (["w/natural=coastline"], lambda t: t.get("natural") == "coastline", None, None, None),
    "trees": (["n/natural=tree"], None, None, lambda t: t.get("natural") == "tree", "skel"),
    "misc": (["w/railway=tram,cable_car,light_rail", "nwr/name"],
             lambda t: t.get("railway") in ("tram", "cable_car", "light_rail") or bool(LANDMARK_NAMES.search(t.get("name", ""))),
             lambda t: bool(LANDMARK_NAMES.search(t.get("name", ""))),
             lambda t: bool(LANDMARK_NAMES.search(t.get("name", ""))), "tags"),
}

_esc = re.compile(r"%([0-9a-fA-F]+)%")


def unesc(s):
    return _esc.sub(lambda m: chr(int(m.group(1), 16)), s)


def parse_tags(field):
    out = {}
    if field:
        for kv in field.split(","):
            k, _, v = kv.partition("=")
            out[unesc(k)] = unesc(v)
    return out


def osmium(*args):
    subprocess.run([OSMIUM, *args], check=True, capture_output=True)


def read_opl(path):
    """-> node ids/lon/lat arrays (sorted by id), node tags, ways, relations"""
    nid, nlon, nlat, ntags = [], [], [], {}
    ways, rels = [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split(" ")
            kind, oid = parts[0][0], int(parts[0][1:])
            fields = {p[0]: p[1:] for p in parts[1:] if p}
            tags = parse_tags(fields.get("T", ""))
            if kind == "n":
                if "x" in fields and fields["x"]:
                    nid.append(oid); nlon.append(float(fields["x"])); nlat.append(float(fields["y"]))
                    if tags:
                        ntags[oid] = tags
            elif kind == "w":
                refs = [int(r[1:]) for r in fields.get("N", "").split(",") if r]
                ways.append((oid, tags, refs))
            elif kind == "r":
                mem = []
                for m in fields.get("M", "").split(","):
                    if not m:
                        continue
                    ref, _, role = m.partition("@")
                    mem.append((ref[0], int(ref[1:]), unesc(role)))
                rels.append((oid, tags, mem))
    order = np.argsort(np.array(nid, dtype=np.int64))
    ids = np.array(nid, dtype=np.int64)[order]
    return ids, np.array(nlon)[order], np.array(nlat)[order], ntags, ways, rels


def build(name, src):
    exprs, way_ok, rel_ok, node_ok, node_out = CATEGORIES[name]
    t0 = time.perf_counter()
    filt = os.path.join(WORK, f"{name}.osm.pbf")
    opl = os.path.join(WORK, f"{name}.opl")
    osmium("tags-filter", src, *exprs, "-o", filt, "--overwrite")
    osmium("cat", filt, "-f", "opl,add_metadata=false", "-o", opl, "--overwrite")
    ids, lon, lat, ntags, ways, rels = read_opl(opl)

    def coords(refs):
        k = np.searchsorted(ids, refs)
        k = np.clip(k, 0, len(ids) - 1)
        ok = ids[k] == np.asarray(refs, dtype=np.int64)
        return [{"lat": round(float(lat[i]), 7), "lon": round(float(lon[i]), 7)} if o else None
                for i, o in zip(k, ok)]

    way_by_id = {w[0]: w for w in ways}
    els = []
    if node_ok:
        for nid_, t in ntags.items():
            if node_ok(t):
                k = int(np.searchsorted(ids, nid_))
                e = {"type": "node", "id": nid_, "lat": round(float(lat[k]), 7), "lon": round(float(lon[k]), 7)}
                if node_out == "tags":
                    e["tags"] = t
                els.append(e)
    if way_ok:
        for oid, t, refs in ways:
            if t and way_ok(t) and len(refs) >= 2:
                g = coords(refs)
                if all(p is None for p in g):
                    continue
                els.append({"type": "way", "id": oid, "nodes": refs, "geometry": g, "tags": t})
    if rel_ok:
        for oid, t, mem in rels:
            if not rel_ok(t):
                continue
            members = []
            for mt, ref, role in mem:
                if mt != "w" or ref not in way_by_id:
                    continue
                members.append({"type": "way", "ref": ref, "role": role, "geometry": coords(way_by_id[ref][2])})
            if members:
                els.append({"type": "relation", "id": oid, "members": members, "tags": t})
    with open(os.path.join(CACHE, f"osm_{name}.json"), "w", encoding="utf-8") as f:
        json.dump({"elements": els}, f)
    kinds = {k: sum(1 for e in els if e["type"] == k) for k in ("node", "way", "relation")}
    print(f"  {name}: {len(els)} elements {kinds} in {time.perf_counter() - t0:.1f} s", flush=True)
    return kinds


def main():
    pbf = sys.argv[1] if len(sys.argv) > 1 else PBF
    os.makedirs(WORK, exist_ok=True)
    area = os.path.join(WORK, "area.osm.pbf")
    bbox = f"{AREA['w'] - MARGIN},{AREA['s'] - MARGIN},{AREA['e'] + MARGIN},{AREA['n'] + MARGIN}"
    t0 = time.perf_counter()
    osmium("extract", "-b", bbox, "--strategy", "smart", pbf, "-o", area, "--overwrite")
    print(f"area extract {bbox}: {os.path.getsize(area) / 1e6:.1f} MB in {time.perf_counter() - t0:.1f} s", flush=True)
    summary = {name: build(name, area) for name in CATEGORIES}
    with open(os.path.join(CACHE, "osm_summary.json"), "w") as f:
        json.dump({"pbf": os.path.basename(pbf), "bbox": bbox, "counts": summary}, f, indent=1)


if __name__ == "__main__":
    main()
