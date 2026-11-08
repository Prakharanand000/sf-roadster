"""Task 1: ASPRS class histograms for 250 m boxes across 3DEP projects."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import common as C

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "research", "probes", "class_histograms.json")
HALF = 125.0
SF = "CA_SanFrancisco_1_B23"
A2, A3 = "CA_AlamedaCo_2_2021", "CA_AlamedaCo_3_2021"
BOXES = [
    ("Financial District", 37.7925, -122.3990, [SF]),
    ("Outer Sunset houses", 37.7600, -122.4900, [SF]),
    ("Golden Gate Park forest", 37.7695, -122.4660, [SF]),
    ("Bay Bridge west span over water", 37.7985, -122.3770, [SF]),
    ("Downtown Oakland", 37.8044, -122.2712, [A2, A3]),
    ("Lake Merritt", 37.8020, -122.2570, [A2, A3]),
    ("Berkeley campus", 37.8700, -122.2585, [A2, A3]),
    ("MacArthur Maze", 37.8270, -122.2950, [A2, A3]),
]


def main():
    results = []
    area = (2 * HALF) ** 2
    for name, lat, lon, projects in BOXES:
        cx, cy = C.ll_to_sft1(lat, lon)
        x0, y0, x1, y1 = cx - HALF, cy - HALF, cx + HALF, cy + HALF
        for proj in projects:
            rec = {"box": name, "lat": lat, "lon": lon, "project": proj, "area_m2": area}
            try:
                pts, st = C.read_ept(proj, C.bounds_3857_from_sft1(x0, y0, x1, y1))
                m = (pts["X"] >= x0) & (pts["X"] <= x1) & (pts["Y"] >= y0) & (pts["Y"] <= y1)
                pts = C.subset(pts, m)
            except Exception as e:
                rec["error"] = str(e)[:500]
                results.append(rec); print(name, proj, "ERROR", rec["error"]); continue
            n = int(pts["Z"].size)
            rec["total_points"] = n
            if n == 0:
                rec["note"] = "0 points: no coverage"
                results.append(rec); print(name, proj, "0 points"); continue
            w = pts["Withheld"]
            nw = ~w
            first = nw & (pts["ReturnNumber"] == 1)
            ground = nw & (pts["Classification"] == 2)
            hist = C.class_histogram(pts)
            rec.update({
                "class_counts": hist,
                "class_counts_nonwithheld": C.class_histogram(C.drop_withheld(pts)),
                "withheld": int(w.sum()), "overlap": int(pts["Overlap"].sum()),
                "density_total": round(n / area, 2),
                "density_nonwithheld": round(int(nw.sum()) / area, 2),
                "density_first_return": round(int(first.sum()) / area, 2),
                "density_ground_c2": round(int(ground.sum()) / area, 2),
                "has_3_4_5_6_17": {str(c): (c in hist) for c in (3, 4, 5, 6, 17)},
                "z_min": round(float(pts["Z"].min()), 2), "z_max": round(float(pts["Z"].max()), 2),
            })
            results.append(rec)
            print(name, proj, n, rec["density_total"], rec["density_ground_c2"],
                  rec["density_first_return"], hist, "withheld", rec["withheld"])
    veg_bld = [(r["box"], r["project"]) for r in results
               if "class_counts" in r and any(c in r["class_counts"] for c in (3, 4, 5, 6))]
    out = {"half_width_m": HALF, "boxes": results,
           "boxes_with_building_or_vegetation_classes": veg_bld}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print("building/veg boxes:", veg_bld)

main()
