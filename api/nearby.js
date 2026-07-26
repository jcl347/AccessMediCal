/* Vercel serverless function: nearby health resources.
 * Proxies the OpenStreetMap Overpass API server-side (cached, key-free)
 * to return real clinics / pharmacies / hospitals / etc. around a point,
 * within a radius. The client ranks them by distance to find the closest.
 *
 * Reliability: the public Overpass endpoints are often rate-limited or slow,
 * so we race SEVERAL mirrors and take the first that answers (Promise.any).
 */
var REACH = require("./_reach");

var TYPE_FILTERS = {
  pharmacy: ['node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'],
  hospital: ['node["amenity"="hospital"]', 'way["amenity"="hospital"]'],
  urgent_care: ['node["healthcare"="urgent_care"]', 'way["healthcare"="urgent_care"]', 'node["amenity"="clinic"]', 'way["amenity"="clinic"]', 'node["healthcare"="clinic"]', 'way["healthcare"="clinic"]', 'node["amenity"="hospital"]', 'way["amenity"="hospital"]'],
  clinic: ['node["amenity"="clinic"]', 'way["amenity"="clinic"]', 'node["healthcare"="clinic"]', 'way["healthcare"="clinic"]', 'node["healthcare"="centre"]', 'way["healthcare"="centre"]', 'node["healthcare"="community_health_centre"]', 'way["healthcare"="community_health_centre"]', 'node["amenity"="doctors"]', 'way["amenity"="doctors"]'],
  doctor: ['node["amenity"="doctors"]', 'way["amenity"="doctors"]', 'node["healthcare"="doctor"]', 'way["healthcare"="doctor"]'],
  dentist: ['node["amenity"="dentist"]', 'way["amenity"="dentist"]', 'node["healthcare"="dentist"]', 'way["healthcare"="dentist"]'],
  mental_health: ['node["healthcare"="psychotherapist"]', 'way["healthcare"="psychotherapist"]', 'node["healthcare"="counselling"]', 'way["healthcare"="counselling"]', 'node["healthcare:speciality"~"psych|mental|behav|counsel|addict",i]', 'way["healthcare:speciality"~"psych|mental|behav|counsel|addict",i]', 'node["amenity"~"clinic|doctors|hospital"]["name"~"mental|behav|psych|counsel|wellness",i]', 'way["amenity"~"clinic|doctors|hospital"]["name"~"mental|behav|psych|counsel|wellness",i]', 'node["healthcare"~"clinic|centre|hospital"]["name"~"mental|behav|psych|counsel|wellness",i]', 'way["healthcare"~"clinic|centre|hospital"]["name"~"mental|behav|psych|counsel|wellness",i]', 'node["social_facility"]["name"~"mental|behav|psych|counsel",i]', 'way["social_facility"]["name"~"mental|behav|psych|counsel",i]'],
};

var MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function queryMirror(base, ql) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, 9500);
  return fetch(base, {
    method: "POST",
    signal: ctrl.signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "AccessMediCalLA-Navigator/1.0 (https://github.com/jcl347/AccessMedicaid)" },
    body: "data=" + encodeURIComponent(ql),
  }).then(function (r) {
    clearTimeout(t);
    if (!r.ok) throw new Error("status " + r.status);
    return r.json();
  }).then(function (data) {
    if (!data || !Array.isArray(data.elements)) throw new Error("no data");
    if (data.remark && data.elements.length === 0) throw new Error("overpass remark: " + data.remark); // rate-limited/timeout -> try next mirror
    return data;
  }).catch(function (e) { clearTimeout(t); throw e; });
}

/* Resolve with the FIRST mirror that returns a non-empty result. Promise.any would
 * resolve with whichever mirror answers first - including a thin/misconfigured mirror
 * that returns 0 elements, beating a slower mirror with real data. We only settle for
 * empty (or reject) once every mirror has finished. */
function firstNonEmpty(promises) {
  return new Promise(function (resolve, reject) {
    var remaining = promises.length, empty = null, settled = false;
    if (!remaining) { reject(new Error("no mirrors")); return; }
    promises.forEach(function (p) {
      p.then(function (data) {
        if (settled) return;
        if (data && Array.isArray(data.elements) && data.elements.length) { settled = true; resolve(data); return; }
        empty = empty || data;
      }, function () { /* mirror error - ignore, count below */ })
      .then(function () { if (!settled && --remaining === 0) { if (empty) resolve(empty); else reject(new Error("all mirrors empty or failed")); } });
    });
  });
}

/* Drop results that are irrelevant to people filling Medi-Cal scripts or seeking care:
 * Google's "pharmacy" type pulls in veterinary hospitals (pet pharmacies), and OSM tags
 * cannabis dispensaries as pharmacies. Filter by Google's own place types and by name. */
var DROP_TYPES = { veterinary_care: 1, pet_store: 1 };
var DROP_NAME = /(animal hospital|veterinar|\bvet\b|dog\s*&\s*cat|dog and cat|pet hospital|pet clinic|pet care|\bcannabis\b|dispensary|marijuana|\bweed\b|medmen|smoke shop|vape)/i;
function isRelevant(name, types) {
  if (DROP_NAME.test(name || "")) return false;
  if (types && types.some(function (t) { return DROP_TYPES[t]; })) return false;
  return true;
}

/* Optional Google Places provider (used only if GOOGLE_MAPS_API_KEY is set in Vercel).
 * Higher-quality clinic data + phone numbers. NOTE: Google's Places terms generally
 * expect results to be shown on a Google map; enabling this is the project owner's call. */
var GOOGLE_TYPE = { pharmacy: ["pharmacy"], hospital: ["hospital"], dentist: ["dentist"], doctor: ["doctor"] };
var GOOGLE_TEXT = { clinic: "community health clinic", urgent_care: "urgent care clinic", mental_health: "mental health clinic" };
async function googlePlaces(type, radius, lat, lng, key) {
  var fieldMask = "places.displayName,places.location,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.types,places.primaryType";
  var url, body, circle = { center: { latitude: lat, longitude: lng }, radius: Math.min(radius, 50000) };
  if (GOOGLE_TYPE[type]) { url = "https://places.googleapis.com/v1/places:searchNearby"; body = { includedTypes: GOOGLE_TYPE[type], maxResultCount: 20, locationRestriction: { circle: circle } }; }
  else { url = "https://places.googleapis.com/v1/places:searchText"; body = { textQuery: GOOGLE_TEXT[type] || "medical clinic", maxResultCount: 20, locationBias: { circle: circle } }; }
  var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, 9000);
  var r = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask }, body: JSON.stringify(body) });
  clearTimeout(t);
  if (!r.ok) { var et = ""; try { et = await r.text(); } catch (_) {} throw new Error("google " + r.status + (et ? ": " + et.replace(/\s+/g, " ").slice(0, 400) : "")); }
  var j = await r.json();
  return (j.places || [])
    .filter(function (p) { return isRelevant((p.displayName && p.displayName.text) || "", (p.types || []).concat(p.primaryType || [])); })
    .map(function (p) {
      var loc = p.location || {};
      return { name: (p.displayName && p.displayName.text) || "(Unnamed location)", lat: loc.latitude, lng: loc.longitude, phone: p.nationalPhoneNumber || "", address: p.formattedAddress || "", website: p.websiteUri || "" };
    }).filter(function (x) { return isFinite(x.lat) && isFinite(x.lng); });
}

/* Google Places TEXT search - used for brand searches (e.g. "Kaiser Permanente"), where we
 * want every facility carrying a brand name near a point rather than a generic care type. */
async function googlePlacesText(textQuery, radius, lat, lng, key) {
  var fieldMask = "places.displayName,places.location,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.types,places.primaryType";
  var body = { textQuery: textQuery, maxResultCount: 20, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(radius, 50000) } } };
  var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, 9000);
  var r = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask }, body: JSON.stringify(body) });
  clearTimeout(t);
  if (!r.ok) { var et = ""; try { et = await r.text(); } catch (_) {} throw new Error("google " + r.status + (et ? ": " + et.replace(/\s+/g, " ").slice(0, 400) : "")); }
  var j = await r.json();
  return (j.places || []).map(function (p) {
    var loc = p.location || {};
    return { name: (p.displayName && p.displayName.text) || "(Unnamed location)", lat: loc.latitude, lng: loc.longitude, phone: p.nationalPhoneNumber || "", address: p.formattedAddress || "", website: p.websiteUri || "" };
  }).filter(function (x) { return isFinite(x.lat) && isFinite(x.lng); });
}
// Overpass filters for a brand name (indexed key first so the name regex is a fast secondary
// filter - putting name~ first makes Overpass scan every named element and time out).
function brandFilters(brand) {
  var nf = String(brand).replace(/["\\]/g, "");
  var keys = ['"amenity"="hospital"', '"amenity"="clinic"', '"amenity"="doctors"', '"amenity"="pharmacy"', '"healthcare"="hospital"', '"healthcare"="clinic"', '"healthcare"="centre"'];
  var out = [];
  keys.forEach(function (k) { out.push('node[' + k + ']["name"~"' + nf + '",i]'); out.push('way[' + k + ']["name"~"' + nf + '",i]'); });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  var q = req.query || {};
  var lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  var type = String(q.type || "clinic").toLowerCase();
  var brand = String(q.brand || "").trim();
  var radius = parseInt(q.radius || "8047", 10) || 8047;
  radius = Math.min(Math.max(radius, 500), 48000); // 0.3 - ~30 mi (covers a 30-min drive isochrone)
  // Optional radial profile of the client's reachable-area polygon (see api/_reach.js).
  var prof = REACH.parseProfile(q.iso);
  if (!isFinite(lat) || !isFinite(lng)) { res.status(400).json({ ok: false, error: "Missing coordinates" }); return; }

  // Prefer Google Places when a key is configured; otherwise use OpenStreetMap/Overpass.
  // googleStatus is echoed in every response so you can confirm whether the key is
  // actually being used. Add ?debug=1 to see the full Google error text on fallback.
  var debug = String(q.debug || "") === "1";
  // debug only: list env-var NAMES (never values) so a name mismatch is visible.
  var envKeys = debug ? Object.keys(process.env).filter(function (k) { return /google|maps|places|api.?key/i.test(k); }) : undefined;
  var gkey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  var googleStatus = gkey ? "key-present-not-used" : "no-key";

  // Brand search (closed networks like Kaiser): find every facility carrying the brand name.
  if (brand) {
    var brx = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (gkey) {
      try {
        var gb = (await googlePlacesText(brand, radius, lat, lng, gkey)).filter(function (p) { return brx.test(p.name || ""); });
        if (gb.length) { res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800"); res.status(200).json({ ok: true, source: "google", googleStatus: "ok", brand: brand, radius: radius, count: gb.length, places: gb }); return; }
        googleStatus = "google-returned-0";
      } catch (e) { googleStatus = debug ? ("google-error: " + ((e && e.message) || String(e))) : "google-error"; }
    }
    var bql = "[out:json][timeout:25];(" + brandFilters(brand).map(function (f) { return f + "(around:" + radius + "," + lat + "," + lng + ");"; }).join("") + ");out center tags " + (radius > 16000 ? 300 : 100) + ";";
    try {
      var bdata = await firstNonEmpty(MIRRORS.map(function (m) { return queryMirror(m, bql); }));
      var bseen = {};
      var bplaces = (bdata.elements || []).map(function (e) {
        var c = e.type === "node" ? { lat: e.lat, lon: e.lon } : (e.center || {});
        var t = e.tags || {};
        var addr = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
        if (t["addr:city"]) addr += (addr ? ", " : "") + t["addr:city"];
        return { name: t.name || t.operator || "(Unnamed location)", lat: c.lat, lng: c.lon, phone: t.phone || t["contact:phone"] || "", address: addr, website: t.website || t["contact:website"] || "" };
      }).filter(function (x) {
        if (!isFinite(x.lat) || !isFinite(x.lng) || !brx.test(x.name)) return false;
        if (prof && !REACH.withinReach(prof, radius, lat, lng, x.lat, x.lng)) return false;
        var k = x.name + "@" + x.lat.toFixed(4) + "," + x.lng.toFixed(4);
        if (bseen[k]) return false; bseen[k] = 1; return true;
      });
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      res.status(200).json({ ok: true, source: "osm", googleStatus: googleStatus, envKeys: envKeys, brand: brand, radius: radius, count: bplaces.length, places: bplaces }); return;
    } catch (e) {
      res.status(200).json({ ok: false, source: "osm", googleStatus: googleStatus, envKeys: envKeys, brand: brand, error: debug ? ("overpass: " + ((e && e.message) || String(e))) : "Map search is busy right now. Please try again." }); return;
    }
  }
  if (gkey) {
    try {
      var gp = await googlePlaces(type, radius, lat, lng, gkey);
      if (gp && gp.length) { res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800"); res.status(200).json({ ok: true, source: "google", googleStatus: "ok", type: type, radius: radius, count: gp.length, places: gp }); return; }
      googleStatus = "google-returned-0";
    } catch (e) { googleStatus = debug ? ("google-error: " + ((e && e.message) || String(e))) : "google-error"; }
  }

  var filters = TYPE_FILTERS[type] || TYPE_FILTERS.clinic;
  // A 30-min drive area is ~30 mi across; capping Overpass at 250 elements there meant whole
  // stretches of it came back empty. Ask for more when the area is big - it's a free endpoint,
  // and the spread cap below keeps the response size sane.
  var outCap = radius > 24000 ? 800 : radius > 12000 ? 500 : 250;
  var ql = "[out:json][timeout:25];(" +
    filters.map(function (f) { return f + "(around:" + radius + "," + lat + "," + lng + ");"; }).join("") +
    ");out center tags " + outCap + ";";

  try {
    var data = await firstNonEmpty(MIRRORS.map(function (m) { return queryMirror(m, ql); }));
    var seen = {};
    var places = (data.elements || []).map(function (e) {
      var c = e.type === "node" ? { lat: e.lat, lon: e.lon } : (e.center || {});
      var t = e.tags || {};
      var addr = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
      if (t["addr:city"]) addr += (addr ? ", " : "") + t["addr:city"];
      return {
        name: t.name || t.operator || t["healthcare:speciality"] || "(Unnamed location)",
        lat: c.lat, lng: c.lon,
        phone: t.phone || t["contact:phone"] || "",
        address: addr,
        website: t.website || t["contact:website"] || "",
      };
    }).filter(function (x) {
      if (!isFinite(x.lat) || !isFinite(x.lng)) return false;
      if (!isRelevant(x.name, [])) return false;
      if (prof && !REACH.withinReach(prof, radius, lat, lng, x.lat, x.lng)) return false;
      var k = x.name + "@" + x.lat.toFixed(4) + "," + x.lng.toFixed(4);
      if (seen[k]) return false; seen[k] = 1; return true;
    });
    // Keep the cap spread across the whole area rather than returning only the closest ones.
    var found = places.length;
    places = REACH.spreadCap(places, lat, lng, REACH.placeCap(radius));
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ ok: true, source: "osm", googleStatus: googleStatus, envKeys: envKeys, type: type, radius: radius, count: found, returned: places.length, places: places });
  } catch (e) {
    res.status(200).json({ ok: false, source: "osm", googleStatus: googleStatus, envKeys: envKeys, error: debug ? ("overpass: " + ((e && e.message) || String(e))) : "Map search is busy right now. Please try again, or use the Google Maps link." });
  }
};
