// SF Roadster Rush - the v2 world projection in JS (tools/geo2.py is the reference):
// transverse Mercator on GRS80, origin Union Square (37.7880 N, 122.4075 W), k0 = 1,
// x = easting, z = -northing. Snyder (1987) series; agrees with PROJ to < 1 mm over the map.
const A = 6378137, F = 1 / 298.257222101;
const E2 = 2 * F - F * F, EP2 = E2 / (1 - E2);
const LAT0 = (37.788 * Math.PI) / 180, LON0 = (-122.4075 * Math.PI) / 180;
const E4 = E2 * E2, E6 = E4 * E2;
const M1 = 1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256, M2 = (3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024;
const M3 = (15 * E4) / 256 + (45 * E6) / 1024, M4 = (35 * E6) / 3072;
const merid = (p) => A * (M1 * p - M2 * Math.sin(2 * p) + M3 * Math.sin(4 * p) - M4 * Math.sin(6 * p));
const MER0 = merid(LAT0);

/** (lat, lon) degrees -> [x, z] v2 world metres. */
export function proj2(lat, lon) {
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
  const s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, a = (l - LON0) * c;
  const a2 = a * a;
  const x = N * (a + ((1 - T + C) * a * a2) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * a * a2 * a2) / 120);
  const y = merid(p) - MER0 + N * t * (a2 / 2 + ((5 - T + 9 * C + 4 * C * C) * a2 * a2) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * a2 * a2 * a2) / 720);
  return [x, -y];
}

/** v1 world metres (equirectangular, tools/geo.py) -> (lat, lon) degrees. */
export function unprojV1(x, z) {
  const KX = 111320.0 * Math.cos((37.788 * Math.PI) / 180), KZ = 110540.0;
  return [37.788 - z / KZ, -122.4075 + x / KX];
}

/** v1 world position -> v2 world position. */
export function v1ToV2(x, z) {
  const [lat, lon] = unprojV1(x, z);
  return proj2(lat, lon);
}
