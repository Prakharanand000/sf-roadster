"""Fetch OpenStreetMap data for the SF Roadster Rush map via Overpass.

Run once:  python tools/fetch_osm.py
Raw responses are cached in tools/cache/osm_*.json so reruns never refetch.
"""
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
os.makedirs(CACHE, exist_ok=True)

UA = 'SFRoadsterRush/1.0 (personal game build)'
ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']

S, N, W, E = 37.765, 37.832, -122.490, -122.372


def overpass(name, query):
    path = os.path.join(CACHE, 'osm_%s.json' % name)
    if os.path.exists(path) and os.path.getsize(path) > 100:
        return path
    qpath = os.path.join(CACHE, 'query_%s.txt' % name)
    with open(qpath, 'w') as f:
        f.write(query)
    tmp = path + '.part'
    last = None
    for attempt in range(6):
        ep = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            # curl (system TLS store) instead of urllib: Python's cert bundle may be stale on Windows
            subprocess.run(['curl', '-s', '-S', '-f', '-A', UA, '--max-time', '400',
                            '--data-urlencode', 'data@' + qpath, '-o', tmp, ep], check=True)
            with open(tmp, 'rb') as f:
                body = f.read()
            os.remove(tmp)
            j = json.loads(body)
            if 'elements' not in j:
                raise RuntimeError('bad response')
            if j.get('remark') and 'runtime error' in j['remark']:
                raise RuntimeError(j['remark'])
            with open(path, 'wb') as f:
                f.write(body)
            print('  %s: %d elements, %.1f MB (%s)' % (name, len(j['elements']), len(body) / 1e6, ep))
            return path
        except Exception as ex:  # noqa
            last = ex
            print('  %s attempt %d failed on %s: %s' % (name, attempt, ep, ex))
            time.sleep(10 + attempt * 10)
    raise RuntimeError('failed %s: %s' % (name, last))


def bbox(s, w, n, e):
    return '(%.5f,%.5f,%.5f,%.5f)' % (s, w, n, e)


def main():
    # Buildings: 3 x 4 tiles
    rows, cols = 3, 4
    for i in range(rows):
        for j in range(cols):
            s = S + (N - S) * i / rows
            n = S + (N - S) * (i + 1) / rows
            w = W + (E - W) * j / cols
            e = W + (E - W) * (j + 1) / cols
            b = bbox(s, w, n, e)
            q = '[out:json][timeout:300];(way["building"]%s;relation["building"]["type"="multipolygon"]%s;);out geom;' % (b, b)
            overpass('bld_%d_%d' % (i, j), q)
            time.sleep(2)
    b = bbox(S, W, N, E)
    # Highways (incl. service), whole area
    q = ('[out:json][timeout:300];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
         'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|service|pedestrian)$"]%s;);out geom;') % b
    overpass('roads', q)
    # Bay Bridge + Golden Gate Bridge in an extended box
    bx = bbox(37.76, -122.50, 37.84, -122.355)
    q = '[out:json][timeout:200];(way["highway"]["bridge"]%s;way["man_made"~"bridge|tower"]%s;way["bridge:structure"]%s;);out geom;' % (bx, bx, bx)
    overpass('bridges', q)
    # Land use / nature / water
    q = ('[out:json][timeout:300];('
         'way["leisure"~"^(park|garden|golf_course|pitch|playground|recreation_ground|nature_reserve|common|dog_park)$"]%s;'
         'relation["leisure"~"^(park|garden|golf_course|recreation_ground|nature_reserve)$"]%s;'
         'way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|allotments|flowerbed)$"]%s;'
         'relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"]%s;'
         'way["natural"~"^(wood|scrub|heath|grassland|beach|sand|water|wetland|bare_rock|cliff)$"]%s;'
         'relation["natural"~"^(wood|scrub|heath|grassland|beach|sand|water|wetland)$"]%s;'
         'way["man_made"~"^(pier|breakwater|groyne)$"]%s;'
         'way["water"]%s;'
         'way["amenity"="parking"]%s;'
         'way["area:highway"]%s;'
         'way["highway"="pedestrian"]["area"="yes"]%s;'
         'way["place"="square"]%s;'
         ');out geom;') % ((b,) * 12)
    overpass('landuse', q)
    bc = bbox(37.74, -122.53, 37.86, -122.33)
    q = '[out:json][timeout:200];(way["natural"="coastline"]%s;);out geom;' % bc
    overpass('coast', q)
    q = '[out:json][timeout:200];(node["natural"="tree"]%s;);out skel;' % b
    overpass('trees', q)
    q = ('[out:json][timeout:200];(way["railway"~"^(tram|cable_car|light_rail)$"]%s;'
         'nwr["name"~"Transamerica|Salesforce Tower|Coit Tower|Ferry Building|Palace of Fine Arts|City Hall|Alcatraz|Pier 39|Oracle Park|Ghirardelli|Dragon Gate|Golden Gate Bridge|Painted Ladies|Fort Point"]%s;'
         ');out geom;') % (b, bbox(37.76, -122.50, 37.84, -122.36))
    overpass('misc', q)
    print('done')


if __name__ == '__main__':
    main()
