/* Shared geometry for "what's reachable" (isochrone) searches.
 *
 * WHY THIS EXISTS: a travel-time isochrone is a star-shaped blob, but the APIs only ever knew a
 * CIRCLE - the radius that circumscribes that blob (up to ~30 mi for a 30-min drive). Two things
 * then pushed every result back toward the middle of the map:
 *   1. the result cap kept the N *nearest* places, and
 *   2. the ZIP sweep queried the N *nearest* ZIP centroids.
 * So a 30-min drive area showed a dense core and empty edges, even though the plan's directory
 * has plenty of providers out along the freeways.
 *
 * The fix: the client sends a compact radial "reach profile" of the actual polygon - the farthest
 * it extends in each of N bearing sectors, in meters (?iso=1200,3400,...). With that we can
 * (a) test candidates against the real shape instead of the circle, and (b) spread the result cap
 * across ring x sector buckets so the far edges always get pins.
 */

function distM(aLat, aLng, bLat, bLng) {
  var R = 6371000, toRad = Math.PI / 180;
  var dLat = (bLat - aLat) * toRad, dLng = (bLng - aLng) * toRad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function bearingDeg(aLat, aLng, bLat, bLng) {
  var toRad = Math.PI / 180;
  var y = Math.sin((bLng - aLng) * toRad) * Math.cos(bLat * toRad);
  var x = Math.cos(aLat * toRad) * Math.sin(bLat * toRad) - Math.sin(aLat * toRad) * Math.cos(bLat * toRad) * Math.cos((bLng - aLng) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// "1200,3400,..." -> [1200, 3400, ...]. Returns null unless it's a usable profile (>= 4 sectors,
// all finite and non-negative) so a malformed param just falls back to the plain circle.
function parseProfile(raw) {
  var s = String(raw || "").trim();
  if (!s) return null;
  var parts = s.split(",").map(function (x) { return parseFloat(x); });
  if (parts.length < 4 || parts.length > 72) return null;
  for (var i = 0; i < parts.length; i++) { if (!isFinite(parts[i]) || parts[i] < 0) return null; }
  return parts;
}

// The farthest a point in this bearing's sector can be and still possibly sit inside the polygon.
// Each entry is that sector's MAXIMUM reach, so this over-approximates the shape - which is what
// we want here: the client still does the exact point-in-polygon test, and over-approximating
// means we never drop a place that really is reachable.
function reachAt(prof, radius, brg) {
  if (!prof || !prof.length) return radius;
  var i = Math.floor(((brg % 360) + 360) % 360 / (360 / prof.length)) % prof.length;
  return prof[i];
}
// Is this point inside the reachable shape (profile) or the plain radius, plus a little slack for
// ZIP-centroid / geocoding wobble?
function withinReach(prof, radius, lat, lng, pLat, pLng) {
  var d = distM(lat, lng, pLat, pLng);
  if (d > radius * 1.1 + 400) return false;
  if (!prof) return true;
  return d <= reachAt(prof, radius, bearingDeg(lat, lng, pLat, pLng)) * 1.1 + 400;
}

// How many places to return. A reachable area 20-30 mi across needs a bigger cap than an 5-mi
// ring, or spreading the results just thins out the middle instead of filling the edges.
function placeCap(radius) { return radius > 24000 ? 500 : radius > 12000 ? 350 : 250; }

/* Trim `list` to `cap` items while keeping the WHOLE search area covered.
 *
 * Buckets everything by (distance ring x bearing sector) and takes one per bucket round-robin,
 * nearest first within each bucket. Round 1 hands every direction and every ring its closest
 * place, round 2 its second-closest, and so on - so a cap that used to be spent entirely on
 * downtown now reaches the far edge in every direction. Falls through untouched when the list
 * already fits. `get` maps an item to {lat, lng} (defaults to the item itself).
 *
 * Returns the picks in ROUND-ROBIN order (one per bucket, then the next per bucket), NOT distance
 * order - sort afterwards if you want nearest-first. Callers that walk the list until they hit a
 * budget (the per-ZIP sweep) want this order: stopping early still leaves every direction covered.
 */
function spreadCap(list, lat, lng, cap, get) {
  if (!list || list.length <= cap) return list;
  get = get || function (p) { return p; };
  var RINGS = 8, SECTORS = 12;
  var wrapped = list.map(function (p) {
    var c = get(p) || {};
    return { p: p, d: distM(lat, lng, c.lat, c.lng), b: bearingDeg(lat, lng, c.lat, c.lng) };
  }).filter(function (w) { return isFinite(w.d); });
  var maxD = 0;
  wrapped.forEach(function (w) { if (w.d > maxD) maxD = w.d; });
  var buckets = {}, keys = [];
  wrapped.forEach(function (w) {
    // sqrt() makes the rings equal-AREA, so the outer ring isn't a sliver that starves.
    var ri = maxD > 0 ? Math.min(RINGS - 1, Math.floor(Math.sqrt(w.d / maxD) * RINGS)) : 0;
    var si = Math.min(SECTORS - 1, Math.floor(w.b / (360 / SECTORS)));
    var k = ri + "|" + si;
    if (!buckets[k]) { buckets[k] = []; keys.push(k); }
    buckets[k].push(w);
  });
  keys.forEach(function (k) { buckets[k].sort(function (a, b) { return a.d - b.d; }); });
  var picked = [], round = 0;
  while (picked.length < cap) {
    var took = 0;
    for (var j = 0; j < keys.length && picked.length < cap; j++) {
      var b = buckets[keys[j]];
      if (round < b.length) { picked.push(b[round]); took++; }
    }
    if (!took) break;
    round++;
  }
  return picked.map(function (w) { return w.p; });
}

module.exports = { distM: distM, bearingDeg: bearingDeg, parseProfile: parseProfile, reachAt: reachAt, withinReach: withinReach, placeCap: placeCap, spreadCap: spreadCap };
