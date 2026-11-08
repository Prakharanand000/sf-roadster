"""Recount OSM statistics for the SF / Oakland / Berkeley notes from a local Geofabrik extract.

Replaces the Overpass counts in tools/research/*.md and tools/MAP_RESOURCES.md
(MAP_RESOURCES.md section 11, gap 3). Offline only.

Interpreters: osmium-tool runs as a CLI from the conda `bake` env; this script
runs under the python.org venv (numpy, pyproj, matplotlib). No pyosmium.

Pipeline (all intermediates in <cache>/osm/work):
  1. admin boundaries -> city polygons (relation ids below) -> `osmium extract -p`
  2. `osmium tags-filter` to the tag families we count, `osmium export` to GeoJSONSeq
  3. stream the features, accumulate per scope:
       city scopes (sf, oakland, berkeley): a feature belongs to a city if its
         representative point is inside the OSM admin polygon (ways: midpoint by
         length; relation areas: mean of the first outer ring). The extract uses
         complete_ways, so ways crossing the border are present whole but are
         counted only where their midpoint lies.
       bbox scopes (the rectangles the old notes used): a way/area counts if any
         vertex is inside the box (the Overpass `way(bbox)` rule).
  4. write tools/research/probes/osm_recount.json
  5. write osm_recount_vs_notes.json (old values from the notes vs new; --compare-only rebuilds just this).

Usage:  python -I tools/probes/osm_recount.py [--compare-only]
"""
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from urllib.parse import unquote

import numpy as np
from matplotlib.path import Path as MPath
from pyproj import Geod

BAKE_ENV = os.environ.get("SF_BAKE_ENV", os.path.expanduser(r"~\miniforge3\envs\bake"))
OSMIUM = os.path.join(BAKE_ENV, "Library", "bin", "osmium.exe")
CACHE = os.environ.get("SF_BAKE_CACHE", os.path.expanduser(r"~\Downloads\sf-roadster-bakecache"))
OSMDIR = os.path.join(CACHE, "osm")
WORK = os.path.join(OSMDIR, "work")
NORCAL = os.path.join(OSMDIR, "norcal-latest.osm.pbf")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO, "tools", "research", "probes")
OUT_JSON = os.path.join(OUT_DIR, "osm_recount.json")
OUT_CMP = os.path.join(OUT_DIR, "osm_recount_vs_notes.json")

# OSM admin relations (boundary=administrative), found by name in the PBF.
CITY_RELATIONS = {
    "sf": {"id": 111968, "name": "San Francisco", "admin_level": 6},
    "oakland": {"id": 2833530, "name": "Oakland", "admin_level": 8},
    "berkeley": {"id": 2833528, "name": "Berkeley", "admin_level": 8},
}
# (south, west, north, east): the rectangles used by the old notes.
BBOXES = {
    "sf_bbox": (37.70, -122.53, 37.84, -122.35),
    "oakland_bbox": (37.70, -122.35, 37.835, -122.11),
    "emeryville_bbox": (37.828, -122.32, 37.850, -122.275),
    "berkeley_bbox": (37.848, -122.335, 37.91, -122.21),
    "phase2_bbox": (37.76, -122.38, 37.90, -122.17),
    "ferry_bbox": (37.60, -122.60, 38.00, -122.10),
}
BIG_BBOX = (-122.62, 37.58, -122.00, 38.02)  # W,S,E,N for the shared bay cut

DRIVABLE = ["motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
            "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
            "unclassified", "living_street", "service"]
DRIVABLE_SET = set(DRIVABLE)
BARRIER_FOCUS = ["guard_rail", "retaining_wall", "wall", "kerb", "fence", "bollard", "jersey_barrier"]

FILTERS = [
    "nwr/highway", "nwr/building", "nwr/building:part", "nwr/natural=tree", "nwr/natural=tree_row",
    "nwr/barrier", "nwr/kerb", "nwr/crossing", "nwr/tunnel", "nwr/bridge", "nwr/railway",
    "nwr/leisure=park", "nwr/man_made=bridge", "nwr/emergency=fire_hydrant",
    "nwr/amenity=bench,waste_basket,post_box,shelter", "nwr/shelter", "nwr/power=pole,minor_line,line",
    "nwr/traffic_calming", "nwr/trolley_wire", "nwr/aerialway", "nwr/electrified",
    "nwr/route=ferry,tram,light_rail,subway,train,funicular,monorail,railway", "r/name~[Cc]able",
]

GEOD = Geod(ellps="WGS84")


def osmium(*args):
    r = subprocess.run([OSMIUM, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("osmium %s failed: %s" % (" ".join(args), r.stderr[-500:]))
    return r.stdout


# ---------------------------------------------------------------- preparation
def prepare():
    os.makedirs(WORK, exist_ok=True)
    big = os.path.join(WORK, "bay_big.osm.pbf")
    if not os.path.exists(big):
        w, s, e, n = BIG_BBOX
        osmium("extract", "-b", "%s,%s,%s,%s" % (w, s, e, n), "-s", "complete_ways", NORCAL, "-o", big)
    adm = os.path.join(WORK, "admin_all.osm.pbf")
    if not os.path.exists(adm):
        osmium("tags-filter", NORCAL, "r/boundary=administrative", "-o", adm)
    for c, rel in CITY_RELATIONS.items():
        poly = os.path.join(WORK, "poly_%s.geojson" % c)
        city = os.path.join(WORK, "city_%s.osm.pbf" % c)
        if not os.path.exists(poly):
            relpbf = os.path.join(WORK, "rel_%s.osm.pbf" % c)
            raw = os.path.join(WORK, "poly_%s_raw.geojson" % c)
            osmium("getid", "-r", adm, "r%d" % rel["id"], "-o", relpbf, "--overwrite")
            osmium("export", relpbf, "-f", "geojson", "-o", raw, "--overwrite", "-u", "type_id")
            d = json.load(open(raw, encoding="utf-8"))
            f = [f for f in d["features"] if f["geometry"]["type"] == "MultiPolygon"][0]
            json.dump({"type": "Feature", "properties": {}, "geometry": f["geometry"]}, open(poly, "w"))
        if not os.path.exists(city):
            osmium("extract", "-p", poly, "-s", "complete_ways", NORCAL, "-o", city)
    for name in ["bay_big"] + list(CITY_RELATIONS):
        src = os.path.join(WORK, "bay_big.osm.pbf" if name == "bay_big" else "city_%s.osm.pbf" % name)
        flt = os.path.join(WORK, "f_%s.osm.pbf" % name)
        seq = os.path.join(WORK, "f_%s.geojsonseq" % name)
        if not os.path.exists(flt):
            osmium("tags-filter", src, *FILTERS, "-o", flt)
        if not os.path.exists(seq):
            osmium("export", flt, "-f", "geojsonseq", "-o", seq, "-u", "type_id", "--overwrite")


# ---------------------------------------------------------------- geometry
class CityPoly:
    def __init__(self, path):
        g = json.load(open(path, encoding="utf-8"))["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        self.outer, self.holes = [], []
        for p in polys:
            self.outer.append(MPath(np.array(p[0])))
            self.holes += [MPath(np.array(r)) for r in p[1:]]
        allpts = np.vstack([o.vertices for o in self.outer])
        self.bb = (allpts[:, 0].min(), allpts[:, 1].min(), allpts[:, 0].max(), allpts[:, 1].max())

    def contains(self, lon, lat):
        if not (self.bb[0] <= lon <= self.bb[2] and self.bb[1] <= lat <= self.bb[3]):
            return False
        pt = (lon, lat)
        if not any(o.contains_point(pt) for o in self.outer):
            return False
        return not any(h.contains_point(pt) for h in self.holes)


def line_len_mid(coords):
    """Length in metres and the point at half length, for a LineString coordinate list."""
    a = np.asarray(coords, dtype=float)
    if len(a) < 2:
        return 0.0, (a[0][0], a[0][1])
    _, _, d = GEOD.inv(a[:-1, 0], a[:-1, 1], a[1:, 0], a[1:, 1])
    cum = np.cumsum(d)
    total = float(cum[-1])
    if total <= 0:
        return 0.0, (a[0][0], a[0][1])
    i = int(np.searchsorted(cum, total / 2))
    prev = cum[i - 1] if i > 0 else 0.0
    t = (total / 2 - prev) / d[i] if d[i] > 0 else 0.0
    return total, (a[i][0] + t * (a[i + 1][0] - a[i][0]), a[i][1] + t * (a[i + 1][1] - a[i][1]))


def outer_rings(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [p[0] for p in geom["coordinates"]]
    return []


def in_bbox_any(arr, bb):
    s, w, n, e = bb
    return bool(((arr[:, 1] >= s) & (arr[:, 1] <= n) & (arr[:, 0] >= w) & (arr[:, 0] <= e)).any())


# ---------------------------------------------------------------- counting
def has_prefix(tags, prefix):
    return any(k.startswith(prefix) for k in tags)


def not_no(tags, k):
    v = tags.get(k)
    return v is not None and v != "no"


COV = [
    ("name", lambda t: "name" in t),
    ("width", lambda t: "width" in t),
    ("lanes", lambda t: "lanes" in t),
    ("maxspeed", lambda t: "maxspeed" in t),
    ("surface", lambda t: "surface" in t),
    ("incline", lambda t: "incline" in t),
    ("sidewalk_any", lambda t: has_prefix(t, "sidewalk")),
    ("cycleway_any", lambda t: has_prefix(t, "cycleway")),
    ("oneway_any", lambda t: "oneway" in t),
    ("oneway_yes", lambda t: t.get("oneway") == "yes"),
    ("bridge", lambda t: not_no(t, "bridge")),
    ("tunnel", lambda t: not_no(t, "tunnel")),
    ("layer", lambda t: "layer" in t),
    ("turn_lanes_any", lambda t: has_prefix(t, "turn:lanes")),
    ("smoothness", lambda t: "smoothness" in t),
    ("lit", lambda t: "lit" in t),
]
VALUE_KEYS = ["lanes", "cycleway", "cycleway:right", "cycleway:left", "cycleway:both", "lane_markings",
              "lanes:bus", "surface:colour", "bus:lanes", "sidewalk", "crossing:markings"]


class Scope:
    def __init__(self):
        self.c = defaultdict(float)

    def add(self, key, v=1):
        self.c[key] += v

    def nested(self):
        out = {}
        for k, v in self.c.items():
            parts = k.split("::")
            d = out
            for p in parts[:-1]:
                d = d.setdefault(p, {})
            d[parts[-1]] = round(v, 3) if isinstance(v, float) and not float(v).is_integer() else int(v)
        return out


def count_feature(sc, fid, tags, km):
    """Accumulate one feature into scope `sc`. km is the way length in km (0 for nodes/areas)."""
    kind = fid[0]  # n / w / r
    A = sc.add

    hw = tags.get("highway")
    # ---- buildings
    if "building" in tags and tags["building"] != "no":
        for grp in (["nwr"] + (["ways"] if kind == "w" else [])):
            A("building::%s::count" % grp)
            for k, name in (("height", "height"), ("building:levels", "building_levels"),
                            ("roof:shape", "roof_shape"), ("roof:levels", "roof_levels"),
                            ("min_height", "min_height"), ("roof:height", "roof_height"),
                            ("name", "name"), ("start_date", "start_date")):
                if k in tags:
                    A("building::%s::with_%s" % (grp, name))
            if "height" in tags or "building:levels" in tags:
                A("building::%s::with_height_or_levels" % grp)
    if "building:part" in tags and tags["building:part"] != "no":
        A("building_part::count")
        for k, name in (("height", "height"), ("building:levels", "building_levels")):
            if k in tags:
                A("building_part::with_%s" % name)

    # ---- highways (ways)
    if hw is not None and kind == "w":
        A("highway_all::ways::total")
        A("highway_all::km::total", km)
        A("highway_all::ways_by_value::%s" % hw)
        A("highway_all::km_by_value::%s" % hw, km)
        b = not_no(tags, "bridge")
        t = not_no(tags, "tunnel")
        if b:
            A("highway_all::bridge_any")
            if "layer" in tags:
                A("highway_all::bridge_any_with_layer")
            if "name" in tags:
                A("highway_all::bridge_any_with_name")
            if "bridge:structure" in tags:
                A("highway_all::bridge_any_with_structure")
            if "ele" in tags:
                A("highway_all::bridge_any_with_ele")
        if tags.get("bridge") == "yes":
            A("highway_all::bridge_yes")
        if t:
            A("highway_all::tunnel_any")
            if "layer" in tags:
                A("highway_all::tunnel_any_with_layer")
            A("highway_all::tunnel_any_by_value::%s" % tags["tunnel"])
        if tags.get("tunnel") == "yes":
            A("highway_all::tunnel_yes")
        if tags.get("tunnel") == "building_passage":
            A("highway_all::building_passage_by_highway::%s" % hw)
        if tags.get("tunnel") == "yes" and hw == "steps":
            A("highway_all::tunnel_yes_steps")
        for k in VALUE_KEYS:
            if k in tags:
                A("highway_values::%s::%s" % (k, tags[k]))

        if hw in DRIVABLE_SET:
            groups = ["drivable"] + ([] if hw == "service" else ["drivable_nonservice"])
            A("road::ways::%s" % hw)
            A("road::km::%s" % hw, km)
            for g in groups:
                A("cov::%s::ways" % g)
                A("cov::%s::km" % g, km)
                for name, fn in COV:
                    if fn(tags):
                        A("cov::%s::with_%s::ways" % (g, name))
                        A("cov::%s::with_%s::km" % (g, name), km)
                if b or t:
                    A("cov::%s::bridge_or_tunnel::ways" % g)
                    A("cov::%s::bridge_or_tunnel::km" % g, km)
                    if "layer" in tags:
                        A("cov::%s::bridge_or_tunnel_with_layer::ways" % g)
                    A("cov::%s::bridge::ways" % g, 1 if b else 0)
                    A("cov::%s::tunnel::ways" % g, 1 if t else 0)
                    if b and "layer" in tags:
                        A("cov::%s::bridge_with_layer::ways" % g)
                    if t and "layer" in tags:
                        A("cov::%s::tunnel_with_layer::ways" % g)
                if tags.get("tunnel") == "yes":
                    A("cov::%s::tunnel_yes::ways" % g)
                    if "layer" in tags:
                        A("cov::%s::tunnel_yes_with_layer::ways" % g)
                if tags.get("tunnel") == "building_passage":
                    A("cov::%s::building_passage::ways" % g)
            if hw != "service" and (b or t):
                nm = tags.get("name") or tags.get("ref") or "(unnamed)"
                if b:
                    A("struct_by_name::bridge::%s" % nm)
                if t:
                    A("struct_by_name::tunnel::%s" % nm)

    # ---- any way with tunnel=building_passage (not only highways)
    if kind == "w" and tags.get("tunnel") == "building_passage":
        A("building_passage::ways")
        A("building_passage::km", km)
    if kind == "w" and "bridge" in tags and hw is None and not_no(tags, "bridge"):
        A("nonhighway_bridge_ways::total")
        if "railway" in tags:
            A("nonhighway_bridge_ways::railway")

    # ---- nodes
    if kind == "n":
        if hw in ("traffic_signals", "stop", "give_way", "crossing", "street_lamp", "bus_stop"):
            A("node::highway=%s" % hw)
            if hw == "traffic_signals" and "traffic_signals:direction" in tags:
                A("node::traffic_signals_with_direction")
            if hw == "crossing":
                A("node::crossing_by_subtype::%s" % tags.get("crossing", "(none)"))
                if "crossing:markings" in tags:
                    A("node::crossing_with_markings")
        if "crossing" in tags and hw != "crossing":
            A("node::crossing_key_without_highway_crossing")
        if "kerb" in tags:
            A("node::kerb_nodes_by_value::%s" % tags["kerb"])
            A("node::kerb_nodes_total")
        if tags.get("natural") == "tree":
            A("node::natural=tree")
            for k in ("height", "species", "genus", "circumference", "leaf_type", "leaf_cycle", "denotation"):
                if k in tags:
                    A("node::tree_with_%s" % k)
        if "barrier" in tags:
            A("barrier_nodes::total")
            A("barrier_nodes::by_type::%s" % tags["barrier"])
        for key, name in (("emergency", "fire_hydrant"),):
            if tags.get(key) == name:
                A("node::emergency=fire_hydrant")
        am = tags.get("amenity")
        if am in ("bench", "waste_basket", "post_box", "shelter"):
            A("node::amenity=%s" % am)
        if "shelter" in tags and tags["shelter"] == "yes":
            A("node::shelter=yes")
        if tags.get("railway") == "subway_entrance":
            A("node::railway=subway_entrance")
        if tags.get("power") == "pole":
            A("node::power=pole")
        if "traffic_calming" in tags:
            A("node::traffic_calming_total")
            A("node::traffic_calming_by_type::%s" % tags["traffic_calming"])
        if "trolley_wire" in tags:
            A("node::trolley_wire")
        if tags.get("leisure") == "park":
            A("park::nodes")
    else:
        # kerb on ways
        if "kerb" in tags and kind == "w":
            A("kerb_ways_by_value::%s" % tags["kerb"])
            A("kerb_ways_total")
        if "barrier" in tags and kind == "w":
            A("barrier_ways::total")
            A("barrier_ways::km_total", km)
            A("barrier_ways::by_type::%s" % tags["barrier"])
            A("barrier_ways::km_by_type::%s" % tags["barrier"], km)
        if tags.get("amenity") == "bench" and kind == "w":
            A("way::amenity=bench")
        if tags.get("amenity") == "shelter" and kind == "w":
            A("way::amenity=shelter")
        if tags.get("emergency") == "fire_hydrant":
            A("way::emergency=fire_hydrant")
        if "traffic_calming" in tags and kind == "w":
            A("way::traffic_calming_total")
        if tags.get("natural") == "tree_row":
            A("tree_row::%s" % ("ways" if kind == "w" else "relations"))
            if kind == "w":
                A("tree_row::km", km)
        if tags.get("natural") == "tree" and kind != "n":
            A("tree_non_node::%s" % kind)
        if tags.get("leisure") == "park":
            A("park::%s" % ("ways" if kind == "w" else "relations"))
        if tags.get("man_made") == "bridge":
            A("man_made_bridge::%s" % ("ways" if kind == "w" else "relations"))
            if "name" in tags:
                A("man_made_bridge::with_name")
        if "trolley_wire" in tags and kind == "w":
            A("trolley_wire::ways_any_value")
            if tags["trolley_wire"] == "yes":
                A("trolley_wire::ways_yes")
                A("trolley_wire::km_yes", km)
            if hw is not None:
                A("trolley_wire::on_highway_ways")
        if "electrified" in tags and kind == "w":
            A("electrified::ways_by_value::%s" % tags["electrified"])
        if "aerialway" in tags and kind == "w":
            A("aerialway::ways_by_value::%s" % tags["aerialway"])
        pw = tags.get("power")
        if pw in ("minor_line", "line") and kind == "w":
            A("power::ways_%s" % pw)
            A("power::km_%s" % pw, km)
        if tags.get("route") == "ferry":
            A("route_ferry::%s" % ("ways" if kind == "w" else "relations"))
            if kind == "w":
                A("route_ferry::km", km)

    # ---- railway (ways)
    rw = tags.get("railway")
    if rw is not None and kind == "w":
        A("railway::ways::%s" % rw)
        A("railway::km::%s" % rw, km)
        if "service" in tags:
            A("railway::ways_with_service_tag::%s" % rw)
        if not_no(tags, "bridge"):
            A("railway::bridge_ways::%s" % rw)
        if not_no(tags, "tunnel"):
            A("railway::tunnel_ways::%s" % rw)
        if rw == "tram" or rw == "light_rail":
            A("railway::%s_tag_combos::gauge=%s" % (rw, tags.get("gauge", "(none)")))
            A("railway::%s_km_by_gauge::%s" % (rw, tags.get("gauge", "(none)")), km)
            if "electrified" in tags:
                A("railway::%s_with_electrified" % rw)
        if rw in ("tram", "funicular", "narrow_gauge", "rail", "light_rail"):
            if tags.get("gauge") == "1067":
                A("railway::gauge_1067_by_type::%s" % rw)
            if "cable" in (tags.get("name", "") + tags.get("operator", "") + tags.get("description", "")).lower():
                A("railway::cable_in_name_by_type::%s" % rw)
    if tags.get("embedded_rails") and kind == "w" and hw is not None:
        A("embedded_rails::highway_ways_by_value::%s" % tags["embedded_rails"])
        A("embedded_rails::highway_ways_total")


def split_feature(line):
    line = line.strip().lstrip("\x1e")
    if not line:
        return None
    return json.loads(line)


def run_stream(path, city_poly=None, city_key=None, bbox_keys=None, scopes=None):
    """Stream a GeoJSONSeq file and add to scopes. Returns number of features."""
    n = 0
    area_only_ways = 0
    bbs = {k: BBOXES[k] for k in (bbox_keys or [])}
    way_ids = set()
    idre = re.compile(r'"id":"w(\d+)"')
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = idre.search(line, 0, 80)
            if m:
                way_ids.add(int(m.group(1)))
    with open(path, encoding="utf-8") as f:
        for line in f:
            feat = split_feature(line)
            if feat is None:
                continue
            n += 1
            props = feat["properties"]
            fid = feat.get("id") or props.get("@id")
            if fid[0] == "a":
                # osmium export emits most closed ways twice (LineString "w<id>" and area "a<2*id>");
                # keep the LineString. Closed ways exported ONLY as an area (e.g. area=yes) are counted
                # as ways via their outer ring. Relation areas "a<2*id+1>" map back to "r<id>".
                num = int(fid[1:])
                if num % 2 == 0:
                    if (num // 2) in way_ids:
                        continue
                    fid = "w%d" % (num // 2)
                    ring = outer_rings(feat["geometry"])[0]
                    feat = {"geometry": {"type": "LineString", "coordinates": ring}, "properties": props}
                    area_only_ways += 1
                else:
                    fid = "r%d" % ((num - 1) // 2)
            tags = {k: v for k, v in props.items() if not k.startswith("@")}
            geom = feat["geometry"]
            gt = geom["type"]
            km = 0.0
            rep = None
            verts = None
            if gt == "Point":
                rep = tuple(geom["coordinates"])
                verts = np.array([rep])
            elif gt == "LineString":
                m, rep = line_len_mid(geom["coordinates"])
                km = m / 1000.0
                verts = np.asarray(geom["coordinates"])
            elif gt in ("Polygon", "MultiPolygon"):
                rings = outer_rings(geom)
                verts = np.vstack([np.asarray(r) for r in rings]) if rings else np.zeros((0, 2))
                r0 = np.asarray(rings[0])
                rep = (float(r0[:, 0].mean()), float(r0[:, 1].mean()))
            else:
                continue
            if city_poly is not None:
                if city_poly.contains(*rep):
                    count_feature(scopes[city_key], fid, tags, km)
            for k, bb in bbs.items():
                if len(verts) and in_bbox_any(verts, bb):
                    count_feature(scopes[k], fid, tags, km)
    print("  area-only closed ways counted as ways:", area_only_ways, flush=True)
    return n


# ---------------------------------------------------------------- route relations (OPL)
def opl_unescape(s):
    return re.sub(r"%([0-9a-fA-F]+)%", lambda m: chr(int(m.group(1), 16)), s)


def parse_opl_tags(tstr):
    out = {}
    if not tstr:
        return out
    for kv in tstr.split(","):
        if "=" in kv:
            k, v = kv.split("=", 1)
            out[opl_unescape(k)] = opl_unescape(v)
    return out


def rail_relations(city):
    """Rail/tram/ferry route relations in a city extract with their member way tags."""
    flt = os.path.join(WORK, "f_%s.osm.pbf" % city)
    opl = osmium("cat", flt, "-f", "opl")
    ways, rels = {}, []
    for ln in opl.splitlines():
        if not ln or ln[0] not in "wr":
            continue
        parts = ln.split(" ")
        ident = int(parts[0][1:])
        tagstr, mem = "", ""
        for p in parts[1:]:
            if p.startswith("T"):
                tagstr = p[1:]
            elif p.startswith("M"):
                mem = p[1:]
        tags = parse_opl_tags(tagstr)
        if ln[0] == "w":
            ways[ident] = tags
        else:
            rels.append((ident, tags, mem))
    out = []
    for rid, tags, mem in rels:
        route = tags.get("route")
        nm = tags.get("name", "")
        if route not in ("tram", "light_rail", "subway", "train", "funicular", "monorail", "railway") \
                and "cable" not in nm.lower():
            continue
        wids = [int(m[1:].split("@")[0]) for m in mem.split(",") if m.startswith("w")]
        combos = defaultdict(int)
        for w in wids:
            wt = ways.get(w)
            if wt is None:
                continue
            combos["railway=%s gauge=%s electrified=%s" % (wt.get("railway", "-"), wt.get("gauge", "-"),
                                                          wt.get("electrified", "-"))] += 1
        out.append({"id": rid, "route": route, "name": nm, "ref": tags.get("ref"), "operator": tags.get("operator"),
                    "network": tags.get("network"), "member_ways": len(wids),
                    "member_way_tag_combos": dict(combos)})
    return out


def cable_car_ways(city):
    """All ways in a city extract tagged railway + (gauge 1067 or 'cable' in name/operator)."""
    flt = os.path.join(WORK, "f_%s.osm.pbf" % city)
    opl = osmium("cat", flt, "-f", "opl")
    combos = defaultdict(int)
    for ln in opl.splitlines():
        if not ln.startswith("w"):
            continue
        tagstr = ""
        for p in ln.split(" ")[1:]:
            if p.startswith("T"):
                tagstr = p[1:]
        t = parse_opl_tags(tagstr)
        if "railway" not in t:
            continue
        txt = (t.get("name", "") + " " + t.get("operator", "") + " " + t.get("description", "")).lower()
        if t.get("gauge") == "1067" or "cable" in txt:
            key = "railway=%s gauge=%s electrified=%s embedded_rails=%s name_has_cable=%s" % (
                t["railway"], t.get("gauge", "-"), t.get("electrified", "-"), t.get("embedded_rails", "-"),
                "cable" in txt)
            combos[key] += 1
    return dict(combos)


def ferry_relations():
    """route=ferry relations in BBOXES['ferry_bbox'] (any member node, or any node of a member way, inside)."""
    out = os.path.join(WORK, "ferry_rel.osm.pbf")
    if not os.path.exists(out):
        osmium("tags-filter", os.path.join(WORK, "bay_big.osm.pbf"), "r/route=ferry", "-o", out)
    s, w, n, e = BBOXES["ferry_bbox"]
    nodes, ways, rels = {}, {}, []
    for ln in osmium("cat", out, "-f", "opl").splitlines():
        parts = ln.split(" ")
        if ln[0] == "n":
            x = y = None
            for p in parts[1:]:
                if p.startswith("x"):
                    x = float(p[1:])
                elif p.startswith("y"):
                    y = float(p[1:])
            if x is not None:
                nodes[int(parts[0][1:])] = (x, y)
        elif ln[0] == "w":
            for p in parts[1:]:
                if p.startswith("N"):
                    ways[int(parts[0][1:])] = [int(v[1:]) for v in p[1:].split(",")]
        elif ln[0] == "r":
            tags, mem = {}, ""
            for p in parts[1:]:
                if p.startswith("T"):
                    tags = parse_opl_tags(p[1:])
                elif p.startswith("M"):
                    mem = p[1:]
            rels.append((int(parts[0][1:]), tags, mem))

    def inside(nid):
        c = nodes.get(nid)
        return c is not None and s <= c[1] <= n and w <= c[0] <= e

    hit = []
    for rid, tags, mem in rels:
        if tags.get("route") != "ferry":
            continue
        ok = False
        for m in mem.split(","):
            if m.startswith("n") and inside(int(m[1:].split("@")[0])):
                ok = True
            elif m.startswith("w") and any(inside(i) for i in ways.get(int(m[1:].split("@")[0]), [])):
                ok = True
        if ok:
            hit.append({"id": rid, "name": tags.get("name"), "operator": tags.get("operator")})
    return {"count": len(hit), "relations": hit}


# ---------------------------------------------------------------- main
def fileinfo():
    txt = osmium("fileinfo", "-e", NORCAL)
    d = {}
    for ln in txt.splitlines():
        ln = ln.strip()
        for k in ("osmosis_replication_timestamp", "osmosis_replication_sequence_number", "timestamp"):
            if ln.startswith(k + "="):
                d[k] = ln.split("=", 1)[1]
        m = re.match(r"Number of (nodes|ways|relations): (\d+)", ln)
        if m:
            d["n_" + m.group(1)] = int(m.group(2))
    m = re.search(r"Timestamps:\s*\n\s*First: (\S+)\s*\n\s*Last: (\S+)", txt)
    if m:
        d["newest_object_timestamp"] = m.group(2)
        d["oldest_object_timestamp"] = m.group(1)
    return d


# ---------------------------------------------------------------- comparison with the notes
COLS = [("SF", "sf_bbox", "sf"), ("Oakland", "oakland_bbox", "oakland"),
        ("Emeryville", "emeryville_bbox", None), ("Berkeley", "berkeley_bbox", "berkeley")]


def qv(res, scope, path):
    x = res["scopes"].get(scope, {})
    for p in path.split("::"):
        if not isinstance(x, dict) or p not in x:
            return 0
        x = x[p]
    return x


def status(old, new):
    if old is None:
        return "old_value_unconfirmed_or_absent"
    if isinstance(old, list):
        return "within_old_range" if old[0] <= new <= old[1] else "outside_old_range"
    if new == old:
        return "exact"
    if abs(new - old) <= max(3, 0.005 * abs(old)):
        return "close_(<=0.5pct_or_3)"
    return "differs"


def build_comparison(res):
    """Old values (file:line in the notes) next to the recount. Line numbers are as of 2026-10-26."""
    out = []
    NF = "tools/research/"
    MR = "tools/MAP_RESOURCES.md"
    B = "building::nwr::"
    D = "cov::drivable_nonservice::"
    H = "highway_all::"
    N = "node::"
    R = "railway::ways::"

    def add(file, line, what, old, new_bbox, new_city, bbox_scope, city_scope, also_at=None, note=None,
            comparable=True):
        e = {"file_line": "%s:%s" % (file, line), "what": what, "old": old, "new_bbox": new_bbox,
             "new_city_polygon": new_city, "bbox_scope": bbox_scope, "city_scope": city_scope,
             "status": status(old, new_bbox) if comparable else "not_comparable"}
        if isinstance(old, (int, float)) and isinstance(new_bbox, (int, float)) and comparable:
            e["delta_bbox"] = round(new_bbox - old, 3)
        if also_at:
            e["also_at_lines"] = also_at
        if note:
            e["note"] = note
        out.append(e)

    def row(file, line, what, olds, path, also_at=None, fn=None, note=None):
        """One osm-completeness table row with 4 columns (SF, Oakland, Emeryville, Berkeley)."""
        for (cname, bb, city), old in zip(COLS, olds):
            f = fn if fn else (lambda scope, path=path: qv(res, scope, path))
            add(file, line, "%s: %s" % (what, cname), old, f(bb), f(city) if city else None, bb, city,
                also_at=also_at if cname == "SF" else None, note=note)

    def one(file, line, what, old, bbox, city, path=None, fn=None, also_at=None, note=None, comparable=True):
        f = fn if fn else (lambda sc: qv(res, sc, path))
        add(file, line, what, old, f(bbox), f(city) if city else None, bbox, city, also_at=also_at, note=note,
            comparable=comparable)

    def pct(num, den):
        return lambda sc: round(100.0 * qv(res, sc, num) / max(1, qv(res, sc, den)), 2)

    OC = NF + "osm-completeness.md"
    row(OC, 28, "building=* features (nwr)", [170039, 179703, 4817, 54297], B + "count", [40, 180, 204])
    row(OC, 29, "buildings with height", [142420, 155, 14, 35], B + "with_height", [195, 204])
    row(OC, 30, "buildings with building:levels", [3239, 1486, 146, 1997], B + "with_building_levels")
    row(OC, 31, "buildings with roof:shape", [320, 111, 7, 242], B + "with_roof_shape")
    row(OC, 32, "buildings with roof:height", [40, 32, 1, 1], B + "with_roof_height")
    row(OC, 33, "buildings with min_height", [12, 0, 0, 2], B + "with_min_height")
    row(OC, 34, "buildings with name", [3422, 2351, 101, 1086], B + "with_name")
    row(OC, 35, "building:part features", [1688, 561, 196, 126], "building_part::count", [43, 184])
    row(OC, 36, "building:part with height", [979, 235, 2, 8], "building_part::with_height")
    row(OC, 37, "building:part with building:levels", [665, 301, 187, 94], "building_part::with_building_levels")
    row(OC, 52, "road ways (drivable non-service)", [15007, 14797, 855, 4487], D + "ways")
    for line, key, olds in [
            (53, "lanes", [8400, 7574, 458, 2739]), (54, "width", [44, 4, 0, 15]),
            (55, "maxspeed", [5781, 2779, 444, 3376]), (56, "surface", [8806, 5674, 555, 4009]),
            (57, "sidewalk_any", [9198, 8111, 531, 4070]), (58, "cycleway_any", [5725, 4376, 388, 2066]),
            (59, "turn_lanes_any", [2268, 3081, 227, 613]), (60, "layer", [374, 478, 29, 71]),
            (61, "incline", [19, 3, 0, 6]), (62, "oneway_any", [7439, 6279, 465, 2036]),
            (63, "oneway_yes", [6758, 5990, 445, 1512]), (64, "lit", [4934, 839, 57, 626]),
            (65, "name", [13976, 13558, 772, 4197])]:
        row(OC, line, "road ways with %s" % key, olds, D + "with_%s::ways" % key)
    row(OC, 83, "all highway=* ways", [68188, 47889, 2922, 17164], H + "ways::total")
    row(OC, 84, "highway=service ways", [9015, 17048, 944, 4534], H + "ways_by_value::service")
    row(OC, 85, "highway=footway ways", [38848, 13413, 958, 5995], H + "ways_by_value::footway", [74, 175])
    row(OC, 86, "highway=cycleway ways", [626, 589, 93, 298], H + "ways_by_value::cycleway")
    row(OC, 87, "path + steps ways", [3682, 1372, 37, 1553], None,
        fn=lambda sc: qv(res, sc, H + "ways_by_value::path") + qv(res, sc, H + "ways_by_value::steps"))
    row(OC, 88, "highway ways bridge=yes", [738, 797, 45, 210], H + "bridge_yes")
    row(OC, 89, "highway ways bridge != no", [772, 813, 46, 214], H + "bridge_any", [206])
    row(OC, 90, "highway ways tunnel=yes", [229, 50, 7, 29], H + "tunnel_yes", [100])
    row(OC, 91, "highway ways tunnel != no", [406, 152, 23, 75], H + "tunnel_any", [100, 206])
    row(OC, 92, "bridge ways with layer", [707, 752, 40, 171], H + "bridge_any_with_layer", [206])
    row(OC, 93, "tunnel ways with layer", [266, 47, 7, 41], H + "tunnel_any_with_layer", [206])
    row(OC, 94, "bridge ways with name", [234, 393, 25, 83], H + "bridge_any_with_name")
    row(OC, 95, "bridge ways with bridge:structure", [26, 0, 0, 1], H + "bridge_any_with_structure",
        note="SF old 26 is not reproduced (13 in the same box); counted as highway ways with bridge != no.")
    row(OC, 96, "non-highway bridge=* ways", [89, 128, 11, 32], "nonhighway_bridge_ways::total")
    row(OC, 111, "highway=traffic_signals nodes", [2286, 1440, 91, 320], N + "highway=traffic_signals", [207])
    row(OC, 112, "traffic_signals:direction nodes", [460, 348, 8, 60], N + "traffic_signals_with_direction")
    row(OC, 113, "highway=crossing nodes", [19891, 13754, 676, 4642], N + "highway=crossing", [207])
    row(OC, 114, "crossing nodes with a crossing=* subtype", [18174, 12434, 602, 4485], None,
        fn=lambda sc: qv(res, sc, N + "highway=crossing") - qv(res, sc, N + "crossing_by_subtype::(none)"))
    row(OC, 115, "highway=stop nodes", [4941, 5503, 283, 2296], N + "highway=stop", [207])
    row(OC, 116, "highway=give_way nodes", [47, 421, 46, 271], N + "highway=give_way")
    row(OC, 117, "highway=street_lamp nodes", [1801, 886, 61, 91], N + "highway=street_lamp", [132, 178, 198, 207])
    row(OC, 118, "barrier=kerb nodes", [8871, 3243, 331, 2131], "barrier_nodes::by_type::kerb", [207])
    row(OC, 119, "kerb=* nodes (any value)", [11584, 7051, 393, 2879], "node::kerb_nodes_total")
    row(OC, 120, "barrier=kerb ways", [121, 23, 55, 75], "barrier_ways::by_type::kerb")
    row(OC, 121, "natural=tree nodes", [10866, 1946, 185, 873], N + "natural=tree", [133, 207])
    row(OC, 122, "trees with height", [230, 10, 0, 2], N + "tree_with_height")
    row(OC, 123, "trees with species", [446, 45, 0, 124], N + "tree_with_species")
    row(OC, 124, "trees with genus", [326, 43, 0, 3], N + "tree_with_genus")
    row(OC, 125, "trees with circumference", [0, 7, 0, 1], N + "tree_with_circumference")
    row(OC, 126, "natural=tree_row ways", [20, 25, 0, 9], "tree_row::ways")
    row(OC, 127, "highway=bus_stop nodes", [3378, 2009, 102, 756], N + "highway=bus_stop")
    row(OC, 128, "traffic_calming nodes", [889, 2666, 139, 566], N + "traffic_calming_total")
    row(OC, 142, "railway=tram ways", [127, 0, 0, 0], R + "tram")
    row(OC, 143, "railway=cable_car ways", [0, 0, 0, 0], R + "cable_car")
    row(OC, 144, "aerialway=cable_car ways", [1, 0, 0, 0], "aerialway::ways_by_value::cable_car")
    row(OC, 145, "railway=light_rail ways", [456, 0, 0, 0], R + "light_rail", [159])
    row(OC, 146, "railway=subway ways", [62, 182, 0, 37], R + "subway")
    row(OC, 147, "railway=rail ways", [175, 409, 62, 47], R + "rail")
    row(OC, 148, "railway=funicular ways", [3, 17, 0, 0], R + "funicular")
    row(OC, 149, "trolley_wire=yes ways", [1806, 0, 0, 0], "trolley_wire::ways_yes", [157, 185, 208])
    row(OC, 150, "trolley_wire=* ways (any value)", [1861, 1, 0, 1], "trolley_wire::ways_any_value", [208])
    row(OC, 151, "trolley_wire on nodes", [0, 0, 0, 0], "node::trolley_wire")
    row(OC, 152, "electrified=contact_line ways", [611, 0, 0, 0], "electrified::ways_by_value::contact_line")
    row(OC, 153, "railway=tram ways with electrified", [126, 0, 0, 0], "railway::tram_with_electrified",
        note="old text: '126 of 127'")

    NL = NF + "night-lighting-data.md"
    one(NL, 14, "OSM street_lamp nodes, SF", [1445, 1451], "sf_bbox", "sf", N + "highway=street_lamp",
        note="osm-completeness.md:117 already says 1,801 for this box; night-lighting-data.md used a partial query.")
    one(NL, 14, "OSM street_lamp nodes, Oakland bbox", 956, "oakland_bbox", "oakland", N + "highway=street_lamp")
    one(NL, 14, "OSM street_lamp nodes, Berkeley", 105, "berkeley_bbox", "berkeley", N + "highway=street_lamp")
    SFN = NF + "street-furniture.md"
    for ln in (21, 80, 176):
        one(SFN, ln, "OSM emergency=fire_hydrant nodes, SF bbox", 1241, "sf_bbox", "sf",
            N + "emergency=fire_hydrant")
    one(SFN, 13, "OSM highway=street_lamp nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        N + "highway=street_lamp", also_at=[159])
    one(SFN, 18, "OSM power=pole nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf", N + "power=pole",
        also_at=[159])
    one(SFN, 18, "OSM power=minor_line ways, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        "power::ways_minor_line")
    one(SFN, 19, "OSM trolley_wire=yes ways, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        "trolley_wire::ways_yes", also_at=[159])
    one(SFN, 22, "OSM amenity=waste_basket nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        N + "amenity=waste_basket", also_at=[159])
    one(SFN, 23, "OSM amenity=bench nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf", N + "amenity=bench",
        also_at=[159])
    one(SFN, 20, "OSM shelter=yes nodes, SF bbox (bus shelters; was UNCONFIRMED)", None, "sf_bbox", "sf",
        N + "shelter=yes", also_at=[87, 159])
    one(SFN, 31, "OSM amenity=post_box nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        N + "amenity=post_box", also_at=[159])
    one(SFN, 92, "OSM railway=subway_entrance nodes, SF bbox (was UNCONFIRMED)", None, "sf_bbox", "sf",
        N + "railway=subway_entrance", also_at=[159])
    ST = NF + "structures.md"
    one(ST, 14, "OSM highway bridge ways (bridge != no), SF bbox", 772, "sf_bbox", "sf", H + "bridge_any",
        also_at=[24, 148])
    one(ST, 14, "OSM highway bridge ways (bridge != no), Phase-2 bbox", 901, "phase2_bbox", None, H + "bridge_any",
        also_at=[25, 148])
    one(ST, 15, "OSM highway tunnel ways (tunnel != no), SF bbox", 406, "sf_bbox", "sf", H + "tunnel_any",
        also_at=[148])
    one(ST, 15, "... of which steps", 125, "sf_bbox", "sf", H + "tunnel_yes_steps")
    one(ST, 15, "... of which tunnel=building_passage (highway ways)", 165, "sf_bbox", "sf",
        H + "tunnel_any_by_value::building_passage", note="old value was approximate ('~165').")
    one(ST, 15, "... vehicle tunnels: drivable non-service highway ways with tunnel=yes", 25, "sf_bbox", "sf",
        D + "tunnel_yes::ways", note="old value approximate ('~25'); counted motorway..unclassified + links with tunnel=yes.")

    def rail_tunnels(sc):
        return sum((res["scopes"][sc].get("railway", {}).get("tunnel_ways", {}) or {}).values())

    one(ST, 16, "Phase-2 bbox highway tunnel ways (tunnel != no; was UNCONFIRMED)", None, "phase2_bbox", None,
        H + "tunnel_any", also_at=[139])
    one(ST, 16, "Phase-2 bbox railway tunnel ways (any railway=*; was UNCONFIRMED)", None, "phase2_bbox", None,
        None, fn=rail_tunnels)
    one(ST, 16, "SF bbox railway tunnel ways (any railway=*; was UNCONFIRMED)", None, "sf_bbox", "sf", None,
        fn=rail_tunnels)
    WS = NF + "water-shoreline.md"
    one(WS, 51, "route=ferry ways in 37.60..38.00, -122.60..-122.10", 24, "ferry_bbox", None, "route_ferry::ways")
    add(WS, 51, "route=ferry relations in the same box", 30, res["ferry_relations_in_ferry_bbox"]["count"], None,
        "ferry_bbox", None)
    RM = NF + "road-markings.md"
    one(RM, 178, "railway=light_rail ways, SF (old = partial 'northern SF extract')", 117, "sf_bbox", "sf",
        R + "light_rail", comparable=False, note="old count came from a partial cache; not comparable.")
    one(RM, 179, "railway=tram ways, SF (old = partial extract)", 36, "sf_bbox", "sf", R + "tram",
        comparable=False, note="old count came from a partial cache; not comparable.")
    one(RM, 180, "railway=tram gauge=1067 ways (cable car track), SF", 77, "sf_bbox", "sf",
        "railway::tram_tag_combos::gauge=1067",
        note="77 of these have electrified=no and 1 has no electrified tag; the old 77 is the electrified=no subset.")
    one(RM, 194, "OSM ways in the SF cache (osm_roads.json, 11,004)", 11004, "sf_bbox", "sf", D + "ways",
        comparable=False, note="cache extent unknown (northern SF); value shown is all drivable non-service ways for scale.")
    one(OC, 156, "railway=cable_car ways (cable cars are railway=tram gauge=1067, see report)", 0, "sf_bbox", "sf",
        R + "cable_car", also_at=[186, 194, 208])
    one(MR, 201, "railway=cable_car ways (same statement in MAP_RESOURCES)", 0, "sf_bbox", "sf", R + "cable_car")
    lamps = qv(res, "sf_bbox", N + "highway=street_lamp")
    one(MR, 246, "OSM street lamps SF as % of ~44k real (old ~3%)", [2.5, 3.5], "sf_bbox", "sf", None,
        fn=lambda sc: round(100.0 * qv(res, sc, N + "highway=street_lamp") / 44000.0, 2),
        note="43-45k is the notes' own figure, not from OSM: at 43k %.1f%%, at 45k %.1f%%." % (
            100.0 * lamps / 43000, 100.0 * lamps / 45000))
    one(MR, 407, "tunnel=building_passage highway ways (~165)", 165, "sf_bbox", "sf",
        H + "tunnel_any_by_value::building_passage",
        note="all ways with tunnel=building_passage: %d in sf_bbox" % qv(res, "sf_bbox", "building_passage::ways"))
    BH = NF + "building-heights-method.md"
    one(BH, 12, "OSM-tagged building heights, SF (~143k)", 143000, "sf_bbox", "sf", B + "with_height",
        also_at=[51, 449], note="old value approximate ('~143k').")
    one(BH, 12, "OSM buildings, SF (~171k)", 171000, "sf_bbox", "sf", B + "count", also_at=[374],
        note="old value approximate ('~171k').")
    one(BH, 179, "OSM building:part, SF (note's 1,647 is Overture building_part)", 1647, "sf_bbox", "sf",
        "building_part::count", comparable=False, note="old number is Overture's, not OSM's; shown for scale.")
    one(MR, 111, "OSM building height share, SF (84%)", 84, "sf_bbox", "sf", None,
        fn=pct(B + "with_height", B + "count"))
    for nm, bb, c in (("Oakland", "oakland_bbox", "oakland"), ("Berkeley", "berkeley_bbox", "berkeley"),
                      ("Emeryville", "emeryville_bbox", None)):
        one(MR, 111, "OSM building height share %%, %s (East Bay 0.1-0.3%%)" % nm, [0.1, 0.3], bb, c, None,
            fn=pct(B + "with_height", B + "count"))
        one(MR, 111, "OSM building:levels share %%, %s (1-4%%)" % nm, [1.0, 4.0], bb, c, None,
            fn=pct(B + "with_building_levels", B + "count"))
        one(MR, 111, "OSM roof:shape share %%, %s (0.1-0.4%%)" % nm, [0.1, 0.4], bb, c, None,
            fn=pct(B + "with_roof_shape", B + "count"))
    for nm, bb, c in (("SF", "sf_bbox", "sf"), ("Oakland", "oakland_bbox", "oakland"),
                      ("Berkeley", "berkeley_bbox", "berkeley"), ("Emeryville", "emeryville_bbox", None)):
        one(MR, 123, "OSM road name coverage %%, %s (90-94%%)" % nm, [90.0, 94.0], bb, c, None,
            fn=pct(D + "with_name::ways", D + "ways"))
        one(MR, 123, "OSM road width coverage %%, %s (<0.5%%)" % nm, [0.0, 0.5], bb, c, None,
            fn=pct(D + "with_width::ways", D + "ways"))
    return out


def write_comparison(res):
    entries = build_comparison(res)
    counts = defaultdict(int)
    for e in entries:
        counts[e["status"]] += 1
    out = {"osm_data_timestamp": res["file"].get("timestamp"), "status_counts": dict(counts),
           "note": "new_bbox = recount over the same rectangle the old note used (any-vertex rule); "
                   "new_city_polygon = recount inside the OSM admin polygon (midpoint rule). "
                   "Line numbers are the notes as they stood on 2026-10-26.",
           "entries": entries}
    json.dump(out, open(OUT_CMP, "w", encoding="utf-8"), indent=1)
    print("wrote", OUT_CMP, dict(counts))


def main():
    if "--compare-only" in sys.argv:
        res = json.load(open(OUT_JSON, encoding="utf-8"))
        write_comparison(res)
        return
    prepare()
    res = {"source": "Geofabrik norcal-latest.osm.pbf", "file": fileinfo(), "city_relations": CITY_RELATIONS,
           "bboxes_swne": BBOXES, "scopes": {}}
    scopes = defaultdict(Scope)
    # city scopes
    for c in CITY_RELATIONS:
        poly = CityPoly(os.path.join(WORK, "poly_%s.geojson" % c))
        n = run_stream(os.path.join(WORK, "f_%s.geojsonseq" % c), city_poly=poly, city_key=c, scopes=scopes)
        print(c, "features streamed", n, flush=True)
    # bbox scopes
    n = run_stream(os.path.join(WORK, "f_bay_big.geojsonseq"), bbox_keys=list(BBOXES), scopes=scopes)
    print("bay_big features streamed", n, flush=True)
    for k, sc in scopes.items():
        res["scopes"][k] = sc.nested()
    res["route_relations"] = {c: rail_relations(c) for c in CITY_RELATIONS}
    res["cable_car_like_ways"] = {c: cable_car_ways(c) for c in CITY_RELATIONS}
    res["ferry_relations_in_ferry_bbox"] = ferry_relations()
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(res, open(OUT_JSON, "w", encoding="utf-8"), indent=1, sort_keys=True)
    print("wrote", OUT_JSON)
    write_comparison(res)


if __name__ == "__main__":
    main()
