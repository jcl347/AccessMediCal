/* Vercel serverless function: in-network providers from a plan's FHIR Provider Directory.
 *
 * CMS-9115-F requires Medi-Cal plans to publish a PUBLIC FHIR R4 (Da Vinci PDEX Plan-Net)
 * Provider Directory. We use it as the PRIMARY map source; the client falls back to
 * Google/OpenStreetMap only when a plan has no usable endpoint or it returns nothing.
 *
 * IMPORTANT reality check (verified live): most of these directories DO NOT populate
 * Location.position (no lat/lng), so FHIR `near=` returns nothing. We therefore query by
 * postal code (ZIPs within the search radius, from data/zip-centroids.json) and place pins
 * at the ZIP centroid - approximate to the provider's ZIP area, like Health Net. Endpoints
 * that DO store coordinates (e.g. Blue Shield Promise / Smile CDR) use geo `near` with
 * exact positions. Per-endpoint mode is data/fhir-endpoints.json -> plans[id].geo.
 *
 * Modes: locations (default) and providers (?specialty=... or ?language=...).
 */
var REACH = require("./_reach");
var ENDPOINTS = require("../data/fhir-endpoints.json");
var HN = null; try { HN = require("../data/healthnet-providers.json"); } catch (e) { HN = null; }
var ZIPC = {}; try { ZIPC = require("../data/zip-centroids.json"); } catch (e) { ZIPC = {}; }

var CARE_KEYWORDS = {
  pharmacy: /pharmac|drug|\brx\b|apothec/i,
  hospital: /hospital|medical center|med ctr|emergency/i,
  urgent_care: /urgent|immediate care|walk.?in|express care/i,
  clinic: /clinic|health center|community health|fqhc|medical group|family|primary|practice/i,
  doctor: /clinic|medical group|physician|family|primary|practice|associates/i,
  dentist: /dental|dentist|orthodont|oral|endodont|periodont/i,
  mental_health: /behavioral|mental|psych|counsel|wellness|substance|recovery/i,
};
var SPECIALTY_KW = {
  "primary care": /family medicine|family practice|general practice|general practitioner|internal medicine|\bprimary care\b|nurse practitioner|family nurse|adult medicine|family health|community health|federally qualified|\bfqhc\b/i,
  "pediatrics": /pediatric|\bpeds\b|\bchild|adolescent/i,
  "ob-gyn": /obstetri|gynecolog|ob.?gyn|midwife|maternal.fetal|\bwomen'?s\b/i,
  "mental health": /psychiat|psycholog|behavioral|mental health|counsel|therapist|social work|substance|addiction|marriage and family/i,
  "cardiology": /cardio|heart|vascular/i,
  "dermatology": /dermat|skin/i,
  "vision": /optom|ophthalmol|\bvision\b|\beye\b/i,
  "orthopedics": /orthop|\bbone|\bjoint|sports medicine/i,
};

function num(x) { var n = parseFloat(x); return isFinite(n) ? n : null; }
function zip5(z) { var m = String(z == null ? "" : z).match(/\d{5}/); return m ? m[0] : ""; }

// L.A. Care (and similar Edifecs directories) pack "ORG NAME - Service Type - STREET" into
// address.line, and stamp a placeholder admin address ("9230 W Olympic Blvd Fl 2") with
// mismatched/varying ZIPs onto many unrelated providers. Extract the real street, and flag the
// placeholder so it isn't mapped.
function cleanStreet(line) {
  var s = String(line || "");
  var parts = s.split(/\s+-\s*(?=\S)/); // "ORG - Type - STREET" / "ORG - Type -STREET"
  s = (parts.length > 1 ? parts[parts.length - 1] : s).replace(/\s*\|\s*\d+\s*$/, "").trim();
  return s;
}
// The same packing appears in Location.name ("ORG - Service Type - STREET"). For DISPLAY we want
// the org name (the FIRST segment), not the street. Only collapse when it's clearly packed
// (3+ dash segments, or the last segment is a street that starts with a number) so we don't
// truncate legitimate names that merely contain a hyphen (e.g. "St. Mary - Long Beach").
function cleanOrgName(name) {
  var s = String(name || "").replace(/\s*\|\s*\d+\s*$/, "").trim();
  var parts = s.split(/\s+-\s*(?=\S)/);
  if (parts.length >= 3) return parts[0].trim();
  if (parts.length === 2 && /^\d/.test(parts[1].trim())) return parts[0].trim();
  return s;
}
var PLACEHOLDER_ADDR = /9230\s*w\s*olympic\s*blvd/i;
// General placeholder detector: the same street stamped on >3 different ZIPs can't be a real
// single address - drop those records so they don't pile onto one point.
function dropPlaceholders(list) {
  var byStreet = {};
  list.forEach(function (p) { var s = ((p._addr && p._addr.street) || "").toLowerCase(); if (!s) return; (byStreet[s] = byStreet[s] || {})[(p._addr && p._addr.zip) || ""] = 1; });
  return list.filter(function (p) { var s = ((p._addr && p._addr.street) || "").toLowerCase(); return !s || Object.keys(byStreet[s]).length <= 3; });
}
var distM = REACH.distM;
function nearParam(lat, lng, km) { return lat + "%7C" + lng + "%7C" + km.toFixed(1) + "%7Ckm"; }

// ZIP codes inside the search area, capped for query size. `prof` (the client's reachable-area
// profile, when a travel-time area is active) narrows this to ZIPs actually reachable - and the
// cap is then SPREAD across directions and distance rings instead of taking the nearest N.
// Taking the nearest N is what emptied the edges: around downtown L.A. the closest 300 centroids
// never get out to the ZIPs a 30-min drive really reaches.
function zipsWithin(lat, lng, radiusM, max, prof) {
  var out = [];
  for (var z in ZIPC) {
    var c = ZIPC[z]; if (!c) continue;
    if (!REACH.withinReach(prof, radiusM, lat, lng, c[0], c[1])) continue;
    out.push({ z: z, lat: c[0], lng: c[1], d: distM(lat, lng, c[0], c[1]) });
  }
  out.sort(function (a, b) { return a.d - b.d; });
  return REACH.spreadCap(out, lat, lng, max || 40).map(function (x) { return x.z; });
}
// Bigger search areas (e.g. a 30-min drive isochrone) need more ZIPs so in-network
// coverage expands to fill the reachable area rather than stopping at a small cap.
function zipCap(radiusM) { return radiusM > 34000 ? 400 : radiusM > 24000 ? 300 : radiusM > 12000 ? 180 : 90; }
// Trim a result list to the response cap, keeping the whole area covered (see api/_reach.js) and
// nearest-first. Returning the nearest N is what made a 30-min drive area look like a small blob.
function capped(list, lat, lng, radius) {
  var out = REACH.spreadCap(list, lat, lng, REACH.placeCap(radius));
  out.sort(function (a, b) { return distM(lat, lng, a.lat, a.lng) - distM(lat, lng, b.lat, b.lng); });
  return out;
}
// Wire format for a place. The caps above run to four figures on a big reachable area, so only
// send what the map actually draws: npi and website are server-side only (NPPES lookups / never
// rendered), inNetwork is re-stamped by the client, and every other field is dropped when empty.
// That's roughly a third off the response for free.
var OPTIONAL = ["specialty", "phone", "address", "ipa", "newPatients", "approxByZip"];
function round6(n) { return Math.round(n * 1e6) / 1e6; } // ~10 cm - the rest is geocoder noise
function slim(p) {
  var o = { name: p.name, lat: round6(p.lat), lng: round6(p.lng) };
  OPTIONAL.forEach(function (k) { if (p[k]) o[k] = p[k]; });
  if (p.languages && p.languages.length) o.languages = p.languages;
  return o;
}
// Coordinates for a Location: prefer real FHIR position, else the ZIP centroid (approx).
function coordsFor(res) {
  var a = res && res.address;
  var pos = res && res.position;
  // Use a real position only if it isn't the 0,0 "null island" some servers return (e.g. BSP
  // postalcode-mode Locations) - fall back to the ZIP centroid in that case.
  if (pos) { var la = num(pos.latitude), lo = num(pos.longitude); if (isFinite(la) && isFinite(lo) && (Math.abs(la) > 0.01 || Math.abs(lo) > 0.01)) return { lat: la, lng: lo, approx: false }; }
  var z = a ? zip5(a.postalCode) : "";
  var c = z && ZIPC[z];
  return c ? { lat: c[0], lng: c[1], approx: true } : null;
}

function fetchText(url, ms) {
  var ctrl = new AbortController();
  var t = setTimeout(function () { ctrl.abort(); }, ms || 9000);
  return fetch(url, { signal: ctrl.signal, headers: { Accept: "application/fhir+json, application/json", "User-Agent": "AccessMediCalLA-Navigator/1.0 (+https://github.com/jcl347/AccessMedicaid)" } })
    .then(function (r) { clearTimeout(t); return r.text().then(function (body) { return { ok: r.ok, status: r.status, body: body }; }); })
    .catch(function (e) { clearTimeout(t); throw e; });
}
function parseBundle(r) { if (!r || !r.ok) return null; try { return JSON.parse(r.body); } catch (e) { return null; } }
// Follow FHIR Bundle "next" links to pull the FULL result set. Directories like L.A. Care return
// a small page AND duplicate each provider across dozens of placeholder locations, so a single
// page yields only a handful of UNIQUE doctors - and which ones varies by page. Bounded by a page
// cap and a wall-clock deadline so we stay within the function budget. Returns merged entries.
async function fetchPaged(url, maxPages, ms, deadline) {
  var entries = [], pages = 0, cur = url, truncated = false;
  while (cur && pages < maxPages) {
    if (Date.now() > deadline) { truncated = true; break; }
    var b = parseBundle(await fetchText(cur, ms));
    if (!b) break;
    var ents = b.entry || [];
    entries = entries.concat(ents);
    pages++;
    var next = null;
    (b.link || []).forEach(function (l) { if (l && l.relation === "next" && l.url) next = l.url; });
    if (!next || !ents.length) break;
    if (entries.length > 8000) { truncated = true; break; }
    cur = next;
  }
  if (cur && pages >= maxPages) truncated = true;
  return { entries: entries, truncated: truncated, pages: pages };
}
function bundleResources(b, type) { return (((b && b.entry) || []).map(function (e) { return e && e.resource; }).filter(function (x) { return x && x.resourceType === type; })); }
function indexBundle(b, idx) { ((b && b.entry) || []).forEach(function (e) { var r = e && e.resource; if (r && r.resourceType && r.id) idx[r.resourceType + "/" + r.id] = r; }); return idx; }
function humanName(p) { if (!p) return ""; var n = (p.name && p.name[0]) || {}; if (n.text) return n.text; var g = [].concat(n.given || []).join(" "); return ((g ? g + " " : "") + (n.family || "")).trim(); }
function langsOf(p) { var out = []; ((p && p.communication) || []).forEach(function (cc) { var c = (cc.coding && cc.coding[0]) || {}; var v = c.display || c.code || cc.text; if (v && out.indexOf(v) < 0) out.push(v); }); return out; }
function npiOf(p) { var ids = (p && p.identifier) || []; for (var i = 0; i < ids.length; i++) { if (ids[i] && /npi/i.test(ids[i].system || "") && /^\d{10}$/.test(String(ids[i].value || ""))) return String(ids[i].value); } for (var j = 0; j < ids.length; j++) { if (/^\d{10}$/.test(String(ids[j].value || ""))) return String(ids[j].value); } return ""; }
function langMatch(list, want) { if (!want) return true; want = want.toLowerCase(); return (list || []).some(function (L) { return String(L).toLowerCase().indexOf(want) >= 0; }); }
function telOf(res) { var ph = "", web = ""; ((res && res.telecom) || []).forEach(function (t) { if (t && t.value) { if (t.system === "phone" && !ph) ph = t.value; if (t.system === "url" && !web) web = t.value; } }); return { phone: ph, website: web }; }
function addrOf(loc) { var a = (loc && loc.address) || {}; var s = cleanStreet([].concat(a.line || []).filter(Boolean).join(" ")); if (a.city) s += (s ? ", " : "") + a.city; if (a.state) s += (s ? ", " : "") + a.state; if (a.postalCode) s += " " + a.postalCode; return s.trim(); }
function specialtyText(pr) {
  var set = [];
  function add(v) { v = (v || "").trim(); if (!v || /^(unk|unknown)$/i.test(v)) return; if (set.indexOf(v) < 0) set.push(v); }
  // Many directories (L.A. Care) put a NullFlavor "UNK/unknown" coding on specialty and carry the
  // real specialty in specialty.text - skip those codings so "unknown" never shows to members.
  ((pr && pr.specialty) || []).forEach(function (cc) {
    (cc.coding || []).forEach(function (c) {
      if (/nullflavor/i.test(c.system || "") || (c.code || "").toUpperCase() === "UNK") return;
      add(c.display || c.code);
    });
    add(cc.text);
  });
  return set.join(", ");
}
// Da Vinci PDEX Plan-Net "accepting new patients" extension (on PractitionerRole / HealthcareService).
// Returns true only when the plan explicitly marks the provider as taking NEW patients ("newpt").
function newPatientsOf(res) {
  var exts = (res && res.extension) || [];
  for (var i = 0; i < exts.length; i++) {
    var e = exts[i]; if (!e || !/newpatients/i.test(e.url || "")) continue;
    var sub = e.extension || [];
    for (var j = 0; j < sub.length; j++) {
      var s = sub[j]; if (!s || !/acceptingpatients/i.test(s.url || "")) continue;
      var cs = (s.valueCodeableConcept && s.valueCodeableConcept.coding) || [];
      for (var k = 0; k < cs.length; k++) { if ((cs[k].code || "").toLowerCase() === "newpt") return true; }
    }
  }
  return false;
}
// --- DATA-DRIVEN specialty categories ---------------------------------------------------------
// We do NOT hardcode a specialty menu. Instead we read the specialty strings that a plan's own
// directory/dataset actually carries, normalize each to a clean canonical label (merging the
// many ways the same specialty is written), drop facility-types / generic noise, and surface the
// labels that are actually present (with counts) as the filter chips. Different plans -> different
// chips; plans with no clear specialties -> no specialty chips at all.
var SPEC_CANON = [
  [/family (medicine|practice|health)/, "Family Medicine"],
  [/general (practice|practitioner)/, "General Practice"],
  [/internal medicine|adult medicine/, "Internal Medicine"],
  [/geriatric/, "Geriatrics"],
  [/pediatric|\bpeds\b|adolescent/, "Pediatrics"],
  [/obstetri|gynecolog|\bob.?gyn\b|women.?s health|maternal.?fetal/, "Obstetrics & Gynecology"],
  [/midwife|midwifery/, "Midwifery"],
  [/psychiatr/, "Psychiatry"],
  [/psycholog/, "Psychology"],
  [/behavioral|mental health|counsel|marriage and family|social work|substance|addiction|behavior analyst|applied behavior/, "Behavioral Health"],
  [/anesthesiolog/, "Anesthesiology"],
  [/cardiolog|cardiovascular|\bheart\b/, "Cardiology"],
  [/dermatolog|\bskin\b/, "Dermatology"],
  [/optometr/, "Optometry"],
  [/ophthalmolog/, "Ophthalmology"],
  [/orthop|sports medicine/, "Orthopedics"],
  [/gastroenter/, "Gastroenterology"],
  [/neurolog/, "Neurology"],
  [/endocrin/, "Endocrinology"],
  [/nephrolog/, "Nephrology"],
  [/pulmonolog|pulmonary|respiratory/, "Pulmonology"],
  [/oncolog|hematolog/, "Oncology & Hematology"],
  [/rheumatolog/, "Rheumatology"],
  [/urolog/, "Urology"],
  [/otolaryngolog|\bent\b|ear.?nose.?throat/, "ENT (Ear, Nose & Throat)"],
  [/allerg|immunolog/, "Allergy & Immunology"],
  [/podiatr/, "Podiatry"],
  [/dental|dentist|orthodont|endodont|periodont|oral surgery|oral and maxillo/, "Dental"],
  [/chiropract/, "Chiropractic"],
  [/physical therap|physiotherap/, "Physical Therapy"],
  [/occupational therap/, "Occupational Therapy"],
  [/pain (medicine|management)/, "Pain Management"],
  [/infectious disease/, "Infectious Disease"],
  [/physiatr|physical medicine|rehabilitation/, "Rehabilitation"],
  [/\bsurgery\b|\bsurgeon\b|surgical/, "Surgery"],
];
// Strings that are facility types / roles / generic noise, NOT clinical specialties - drop them.
var SPEC_JUNK = /unknown|^unk$|federally qualified|\bfqhc\b|community health|health center|\bclinic\b|hospital|pharmacy|urgent care|multi.?special|acute care|long.?term care|home health|laboratory|radiolog|imaging|\bnurse\b|registered|\bassistant\b|technician|\baide\b|allied health|^other|^physician|^medicine|^general|^health|^medical|^clinical$|^unsupported$|case manage|care management/;
function normSpec(raw) {
  var s = String(raw || "").toLowerCase()
    .replace(/\([^)]*\)/g, " ")            // drop parentheticals e.g. "(FQHC)"
    .replace(/&/g, " and ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\b(physician|physicians|specialist|specialists|doctor|provider|providers|services|service|disease|diseases|unsupported|not specified)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!s) return "";
  for (var i = 0; i < SPEC_CANON.length; i++) { if (SPEC_CANON[i][0].test(s)) return SPEC_CANON[i][1]; }
  if (SPEC_JUNK.test(s) || s.length < 4 || s.split(" ").length > 4) return "";
  return s.replace(/\band\b/g, "&").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
// Distinct canonical specialty labels present across a list of providers, with counts (top 14).
// We normalize the WHOLE specialty string (normSpec already drops parentheticals and matches a
// canonical category by keyword), rather than splitting on commas - directory specialties often
// contain commas inside their name ("Endocrinology, Diabetes & Metabolism", "Pediatrics (Babies,
// Children)"), which comma-splitting would shatter into junk facets.
function facetSpecialties(list) {
  var counts = {};
  (list || []).forEach(function (p) { var n = normSpec(p.specialty); if (n) counts[n] = (counts[n] || 0) + 1; });
  // For a large roster, drop count-1 specialties: they're the unstable "tail" that wobbles
  // between requests. Small plans keep everything so their few specialties still show.
  var min = ((list || []).length >= 60) ? 2 : 1;
  return Object.keys(counts).map(function (k) { return { label: k, count: counts[k] }; })
    .filter(function (f) { return f.count >= min; })
    .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); })
    .slice(0, 14);
}
// A provider matches the selected (data-derived) specialty label when it canonicalizes to it.
function specSelected(specText, sel) { return !sel || normSpec(specText).toLowerCase() === sel.toLowerCase(); }

// --- DATA-DRIVEN languages (same idea as specialties) -----------------------------------------
// Provider languages come through as display names ("Spanish") OR ISO codes ("es", "es-MX", "spa").
// Normalize to a clean English label; drop English (the default) and unmapped short codes.
var LANG_CODE = { es: "Spanish", spa: "Spanish", zh: "Chinese", zho: "Chinese", cmn: "Mandarin", yue: "Cantonese", vi: "Vietnamese", vie: "Vietnamese", ko: "Korean", kor: "Korean", hy: "Armenian", hye: "Armenian", tl: "Tagalog", fil: "Tagalog", ru: "Russian", rus: "Russian", fa: "Persian (Farsi)", fas: "Persian (Farsi)", per: "Persian (Farsi)", ar: "Arabic", ara: "Arabic", ja: "Japanese", jpn: "Japanese", hi: "Hindi", hin: "Hindi", pa: "Punjabi", pan: "Punjabi", th: "Thai", tha: "Thai", km: "Khmer", khm: "Khmer", he: "Hebrew", heb: "Hebrew", fr: "French", fra: "French", pt: "Portuguese", por: "Portuguese", de: "German", deu: "German" };
var LANG_NAME = [
  [/mandarin/, "Mandarin"], [/cantonese/, "Cantonese"], [/chinese/, "Chinese"],
  [/spanish|castilian/, "Spanish"], [/persian|farsi/, "Persian (Farsi)"],
  [/tagalog|filipino/, "Tagalog"], [/vietnamese/, "Vietnamese"], [/korean/, "Korean"],
  [/armenian/, "Armenian"], [/arabic/, "Arabic"], [/russian/, "Russian"], [/hindi/, "Hindi"],
  [/punjabi/, "Punjabi"], [/japanese/, "Japanese"], [/khmer|cambodian/, "Khmer"],
  [/hebrew/, "Hebrew"], [/french/, "French"], [/portuguese/, "Portuguese"], [/german/, "German"],
  [/thai/, "Thai"], [/sign language|^asl$/, "ASL"],
];
function normLang(raw) {
  // Directories write languages many ways: "Spanish", "es", "es-MX", "Spanish, Castilian",
  // "Mandarin Chinese", "Farsi". Take the leading token, map codes and descriptive names to one
  // clean label, and drop English (the default) + unmapped short codes.
  var s = String(raw || "").split(",")[0].trim(); if (!s) return "";
  var low = s.toLowerCase();
  if (low === "english" || low === "en" || low === "eng" || /^en[-_]/.test(low)) return "";
  if (LANG_CODE[low]) return LANG_CODE[low];
  var base = low.split(/[-_]/)[0]; if (LANG_CODE[base]) return LANG_CODE[base];
  for (var i = 0; i < LANG_NAME.length; i++) { if (LANG_NAME[i][0].test(low)) return LANG_NAME[i][1]; }
  if (s.length <= 3) return ""; // unmapped short code - don't show an ugly "Vi"/"Es"
  return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}
function facetLanguages(list) {
  var counts = {};
  (list || []).forEach(function (p) { var seen = {}; (p.languages || []).forEach(function (L) { var n = normLang(L); if (n && !seen[n]) { seen[n] = 1; counts[n] = (counts[n] || 0) + 1; } }); });
  return Object.keys(counts).map(function (k) { return { label: k, count: counts[k] }; })
    .sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); }).slice(0, 12);
}
function langSelected(langs, sel) { if (!sel) return true; var s = sel.toLowerCase(); return (langs || []).some(function (L) { return normLang(L).toLowerCase() === s; }); }
function specialtyMatcher(s) {
  s = (s || "").toLowerCase().trim();
  if (!s) return null;
  if (SPECIALTY_KW[s]) return SPECIALTY_KW[s];
  for (var k in SPECIALTY_KW) { if (s.indexOf(k) >= 0 || k.indexOf(s) >= 0) return SPECIALTY_KW[k]; }
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}
// --- street-level geocoding via the FREE U.S. Census batch geocoder (no API key) ---
// Upgrades approximate ZIP-centroid pins to EXACT coordinates where the street address
// matches. Strictly additive: any failure (or no match) leaves the ZIP-centroid pin.
var GEO_CACHE = {};
function addrParts(loc) {
  var a = (loc && loc.address) || {};
  return { street: cleanStreet([].concat(a.line || []).filter(Boolean).join(" ")), city: a.city || "", state: a.state || "CA", zip: zip5(a.postalCode) };
}
function csvCell(s) { return String(s == null ? "" : s).replace(/[",\r\n]/g, " ").trim(); }
function parseCsvLine(line) { var out = [], cur = "", q = false; for (var i = 0; i < line.length; i++) { var ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else { if (ch === ",") { out.push(cur); cur = ""; } else if (ch === '"') q = true; else cur += ch; } } out.push(cur); return out; }
async function censusGeocode(places) {
  if (!places || !places.length || typeof FormData === "undefined") return;
  // Don't geocode placeholder streets - the known L.A. Care one, or ANY street stamped on >3
  // distinct ZIPs (a real address has one). Geocoding would collapse them onto a single point;
  // leaving them at their ZIP centroid keeps them scattered and honestly "approximate".
  var byStreet = {};
  places.forEach(function (p) { var s = ((p._addr && p._addr.street) || "").toLowerCase(); if (s) (byStreet[s] = byStreet[s] || {})[(p._addr && p._addr.zip) || ""] = 1; });
  function isPlaceholder(street) { var sl = (street || "").toLowerCase(); return PLACEHOLDER_ADDR.test(street) || (sl && byStreet[sl] && Object.keys(byStreet[sl]).length > 3); }
  var rows = [], map = {};
  places.forEach(function (p, i) {
    if (!p.approxByZip) return; // already has exact coordinates (e.g. Kaiser/BSP near results)
    var a = p._addr || {}; var street = csvCell(a.street);
    if (!street || (!a.zip && !a.city) || isPlaceholder(street)) return;
    var key = (street + "|" + (a.zip || a.city)).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(GEO_CACHE, key)) { var c = GEO_CACHE[key]; if (c) { p.lat = c[0]; p.lng = c[1]; p.approxByZip = false; } return; }
    map[i] = key;
    rows.push(i + "," + street + "," + csvCell(a.city) + "," + csvCell(a.state || "CA") + "," + csvCell(a.zip));
  });
  if (!rows.length) return;
  // Send in parallel chunks rather than one big batch: a reachable-area search returns a few
  // hundred places, and a single batch that size runs past the timeout - which would drop EVERY
  // pin back to its ZIP centroid. Chunks keep each request the size the geocoder answers quickly,
  // and one slow chunk only costs its own addresses.
  function applyResults(text) {
    text.split(/\r?\n/).forEach(function (line) {
      if (!line) return;
      var f = parseCsvLine(line); var id = parseInt(f[0], 10);
      if (!(id in map)) return;
      if (f[2] === "Match" && f[5]) { var ll = f[5].split(","); var lo = parseFloat(ll[0]), la = parseFloat(ll[1]); if (isFinite(la) && isFinite(lo)) { var p = places[id]; if (p) { p.lat = la; p.lng = lo; p.approxByZip = false; } GEO_CACHE[map[id]] = [la, lo]; return; } }
      GEO_CACHE[map[id]] = null;
    });
  }
  async function geocodeChunk(chunk) {
    var fd = new FormData();
    fd.append("benchmark", "Public_AR_Current");
    fd.append("addressFile", new Blob([chunk.join("\n")], { type: "text/csv" }), "a.csv");
    var ctrl = new AbortController(); var t = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      var r = await fetch("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", { method: "POST", body: fd, signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) applyResults(await r.text());
    } catch (e) { clearTimeout(t); /* this chunk keeps its ZIP-centroid pins */ }
  }
  var chunks = [];
  for (var ci = 0; ci < rows.length; ci += 200) chunks.push(rows.slice(ci, ci + 200));
  await Promise.all(chunks.map(geocodeChunk));
}

// --- real practice addresses via the free CMS NPPES NPI registry (no key) ---
// Some directories (L.A. Care) link providers to placeholder Locations. NPPES returns the
// provider's actual LOCATION (practice) address by NPI, which we then geocode. Cached per NPI.
var NPI_CACHE = {};
async function nppesAddress(npi) {
  if (!npi) return null;
  if (Object.prototype.hasOwnProperty.call(NPI_CACHE, npi)) return NPI_CACHE[npi];
  try {
    var r = await fetchText("https://npiregistry.cms.hhs.gov/api/?version=2.1&number=" + encodeURIComponent(npi), 6000);
    if (!r.ok) { NPI_CACHE[npi] = null; return null; }
    var j = JSON.parse(r.body);
    var rec = j && j.results && j.results[0];
    var addrs = (rec && rec.addresses) || [];
    var loc = null, mail = null;
    addrs.forEach(function (a) { if (a.address_purpose === "LOCATION") loc = loc || a; else if (a.address_purpose === "MAILING") mail = mail || a; });
    var a = loc || mail;
    if (!a || !a.address_1 || /\b(p\.?o\.? box|pmb)\b/i.test(a.address_1)) { NPI_CACHE[npi] = null; return null; }
    var street = a.address_1.trim() + (a.address_2 && /ste|suite|fl|#|unit/i.test(a.address_2) ? " " + a.address_2.trim() : "");
    var out = { street: street, city: a.city || "", state: a.state || "CA", zip: zip5(a.postal_code) };
    NPI_CACHE[npi] = out; return out;
  } catch (e) { NPI_CACHE[npi] = null; return null; }
}
// Replace placeholder addresses on provider records with the real NPPES practice address so
// censusGeocode can plot them at their true street. Capped + concurrency-limited.
async function enrichFromNppes(places) {
  if (typeof fetch === "undefined") return;
  var byStreet = {};
  places.forEach(function (p) { var s = ((p._addr && p._addr.street) || "").toLowerCase(); if (s) (byStreet[s] = byStreet[s] || {})[(p._addr && p._addr.zip) || ""] = 1; });
  function isPh(street) { var sl = (street || "").toLowerCase(); return PLACEHOLDER_ADDR.test(street) || (sl && byStreet[sl] && Object.keys(byStreet[sl]).length > 3); }
  var targets = places.filter(function (p) { return p.npi && p._addr && isPh(p._addr.street); }).slice(0, 80);
  if (!targets.length) return;
  var i = 0;
  async function worker() {
    while (i < targets.length) {
      var p = targets[i++];
      var a = await nppesAddress(p.npi);
      if (a) { p._addr = a; p.address = (a.street + (a.city ? ", " + a.city : "") + (a.state ? ", " + a.state : "") + (a.zip ? " " + a.zip : "")).trim(); }
    }
  }
  var ws = []; for (var w = 0; w < 8; w++) ws.push(worker());
  await Promise.all(ws);
}

function normLocation(loc) {
  var co = coordsFor(loc); if (!co) return null;
  var t = telOf(loc), typeText = "";
  (loc.type || []).forEach(function (tc) { (tc.coding || []).forEach(function (c) { typeText += " " + (c.display || c.code || ""); }); if (tc.text) typeText += " " + tc.text; });
  return { name: cleanOrgName(loc.name) || "(In-network location)", lat: co.lat, lng: co.lng, phone: t.phone, address: addrOf(loc), website: t.website, inNetwork: true, approxByZip: co.approx, _typeText: typeText, _addr: addrParts(loc) };
}

// Fetch a Location bundle by the endpoint's geo strategy.
async function locationBundle(base, geoMode, lat, lng, km, radius, zip, prof) {
  if (geoMode === "near") {
    var u = base + "/Location?near=" + nearParam(lat, lng, km) + "&_count=" + (radius > 16000 ? 400 : 100);
    return { url: u, bundle: parseBundle(await fetchText(u, 9000)) };
  }
  var zips = zipsWithin(lat, lng, radius, zipCap(radius), prof);
  if (!zips.length && zip) zips = [zip5(zip)];
  if (!zips.length) return { error: "no-zips" };
  if (geoMode === "postal-single") {
    // Molina ignores comma ZIP lists (total=0) and 500s on chained/_include/_elements queries,
    // so query ZIPs individually via Location?address-postalcode (which works and returns real
    // positions). CRUCIAL: downtown LA's nearest ZIP *centroids* are largely PO-box/admin ZIPs
    // holding ZERO locations, so query a WIDE set (24) to reach the residential ZIPs that
    // actually carry providers - empty ZIPs return instantly. Stop early once we have plenty,
    // and cap concurrency at 4 to stay under the burst rate limit. (Verified: 90011 alone -> 253.)
    // Near a dense downtown, dozens of PO-box/admin ZIPs (which hold 0 locations) rank closest by
    // centroid and crowd the residential ZIPs out of the nearest few, so sweep a LARGE set (50).
    // Empty ZIPs return instantly; we stop early once we have plenty. (Molina doesn't actually
    // rate-limit these single-ZIP Location reads hard - the old "2" was admin ZIPs + a name filter.)
    // pick is in SPREAD order (one ZIP per direction/ring, then the next), so the early stop below
    // leaves the whole area covered instead of only the ZIPs closest to the search point.
    var pick = zips.slice(0, radius > 16000 ? 90 : 50);
    var entry = [], ci = 0;
    var entryBudget = radius > 16000 ? 600 : 200;
    async function zipWorker() {
      while (ci < pick.length && entry.length < entryBudget) {
        var z = pick[ci++];
        var b = await fetchText(base + "/Location?address-postalcode=" + encodeURIComponent(z) + "&_count=80", 7000).then(parseBundle).catch(function () { return null; });
        if (b && b.entry) entry = entry.concat(b.entry);
      }
    }
    var pool = []; for (var w = 0; w < 6; w++) pool.push(zipWorker());
    await Promise.all(pool);
    return { url: "per-ZIP x" + pick.length, zips: pick, bundle: { entry: entry } };
  }
  var u2 = base + "/Location?address-postalcode=" + encodeURIComponent(zips.join(",")) + "&_count=500";
  return { url: u2, zips: zips, bundle: parseBundle(await fetchText(u2, 9000)) };
}

async function locationSearch(base, geoMode, lat, lng, km, radius, type, zip, debug, prof) {
  var lb = await locationBundle(base, geoMode, lat, lng, km, radius, zip, prof);
  if (lb.error) return { ok: false, reason: lb.error };
  if (!lb.bundle) return { ok: false, reason: "fhir-error", query: debug ? [lb.url] : undefined };
  var places = bundleResources(lb.bundle, "Location").map(normLocation).filter(function (p) { return p && REACH.withinReach(prof, radius, lat, lng, p.lat, p.lng); });
  // For a SPECIFIC care type (pharmacy/hospital/dentist/mental health) keep only matching places.
  // For the generic "clinic"/"doctor" location search, keep ALL in-network locations - everything
  // the plan's own directory returns is in-network, so a name that doesn't contain "clinic" is no
  // reason to hide it. (This name filter is what collapsed Molina's location fallback to ~2.)
  var GENERIC = { clinic: 1, doctor: 1 };
  var kw = CARE_KEYWORDS[type];
  if (kw && !GENERIC[type]) { places = places.filter(function (p) { return kw.test((p.name || "") + " " + (p._typeText || "")); }); }
  var seen = {}, out = [];
  places.forEach(function (p) { var k = (p.name || "") + "@" + p.lat.toFixed(4) + "," + p.lng.toFixed(4); if (seen[k]) return; seen[k] = 1; delete p._typeText; out.push(p); });
  out.sort(function (a, b) { return distM(lat, lng, a.lat, a.lng) - distM(lat, lng, b.lat, b.lng); });
  var picked = capped(out, lat, lng, radius);
  return { ok: true, mode: "locations", type: type, radius: radius, approxByZip: picked.some(function (p) { return p.approxByZip; }), count: out.length, returned: picked.length, places: picked, query: debug ? [lb.url] : undefined };
}

// The client opens on a default specialty rather than the whole roster. `prefer` says that
// specialty is the DEFAULT, not the member's own pick: apply it only if this plan's directory
// actually has it, otherwise fall back to the full roster so the map is never empty just because
// a plan writes its specialties differently. An explicitly chosen specialty is always strict.
function applyPreferred(all, specialty, language, prefer) {
  var matched = all.filter(function (p) { return specSelected(p.specialty, specialty) && langSelected(p.languages, language); });
  if (specialty && prefer && !matched.length) {
    return { list: all.filter(function (p) { return langSelected(p.languages, language); }), applied: false };
  }
  return { list: matched, applied: !!specialty };
}

async function providerSearch(base, geoMode, lat, lng, km, radius, specialty, language, zip, debug, prof, prefer) {
  var inc = "&_include=PractitionerRole:practitioner&_include=PractitionerRole:location&_include=PractitionerRole:organization";
  var queries = [], idx = {}, roles = [];
  var truncated = false;
  if (geoMode === "near") {
    var u1 = base + "/PractitionerRole?location.near=" + nearParam(lat, lng, km) + inc + "&_count=200";
    queries.push(u1);
    var p1 = await fetchPaged(u1, 6, 9000, Date.now() + 12000); truncated = truncated || p1.truncated;
    if (p1.entries.length) { var b1 = { entry: p1.entries }; indexBundle(b1, idx); roles = bundleResources(b1, "PractitionerRole"); }
  } else if (geoMode === "postal") {
    var zips = zipsWithin(lat, lng, radius, zipCap(radius), prof);
    if (!zips.length && zip) zips = [zip5(zip)];
    if (!zips.length) return { ok: false, reason: "no-zips" };
    var u2 = base + "/PractitionerRole?location.address-postalcode=" + encodeURIComponent(zips.join(",")) + inc + "&_count=500";
    queries.push(u2);
    // Paginate to pull the full roster (heavy per-provider duplication means one page is too few).
    var p2 = await fetchPaged(u2, 7, 11000, Date.now() + 15000); truncated = truncated || p2.truncated;
    if (p2.entries.length) { var b2 = { entry: p2.entries }; indexBundle(b2, idx); roles = bundleResources(b2, "PractitionerRole"); }
    // postal-single (Molina): skip the chained PR query (server 500s); fall through to two-step.
  }
  // Fallback: some servers reject the chained location.* filter on PractitionerRole (IEHP
  // returns HTTP 400). Get nearby Locations first, then PractitionerRoles that reference them.
  // Skip for postal-single (Molina): it doesn't link PractitionerRole to Location at all
  // (location= returns 0), so don't waste a ZIP sweep here - the handler falls back to the
  // in-network LOCATION search, which is the best Molina supports.
  if (!roles.length && geoMode !== "postal-single") {
    var lb = await locationBundle(base, geoMode, lat, lng, km, radius, zip, prof);
    if (lb && lb.bundle) {
      indexBundle(lb.bundle, idx);
      var locs = bundleResources(lb.bundle, "Location").map(function (l) { var co = coordsFor(l); return co && REACH.withinReach(prof, radius, lat, lng, co.lat, co.lng) ? { id: l.id, lat: co.lat, lng: co.lng, d: distM(lat, lng, co.lat, co.lng) } : null; }).filter(function (x) { return x && x.id; });
      locs.sort(function (a, b) { return a.d - b.d; });
      // Spread the location cap over the area - the nearest 40 all sat on top of each other, so
      // the providers we then looked up never reached the edge of a big reachable area.
      var ids = REACH.spreadCap(locs, lat, lng, radius > 16000 ? 120 : 40).map(function (x) { return x.id; });
      if (ids.length) {
        var u3 = base + "/PractitionerRole?location=" + encodeURIComponent(ids.map(function (i) { return "Location/" + i; }).join(",")) + "&_include=PractitionerRole:practitioner&_include=PractitionerRole:organization&_count=500";
        queries.push(u3);
        var p3 = await fetchPaged(u3, 5, 11000, Date.now() + 12000); truncated = truncated || p3.truncated;
        if (p3.entries.length) { var b3 = { entry: p3.entries }; indexBundle(b3, idx); roles = bundleResources(b3, "PractitionerRole"); }
      }
    }
  }
  if (!roles.length) return { ok: false, reason: "no-providers", query: debug ? queries : undefined };

  // Dedupe by PROVIDER (one entry per doctor at their nearest location). L.A. Care lists the
  // same doctor at several placeholder "locations" with different ZIPs - this collapses those.
  // NOTE: we build the FULL set first (no specialty filter), so the specialty facet reflects the
  // plan's whole nearby roster; the selected specialty filter is applied afterward.
  var byName = {};
  roles.forEach(function (pr) {
    var spec = specialtyText(pr), prTel = telOf(pr), newPt = newPatientsOf(pr);
    var pract = (pr.practitioner && pr.practitioner.reference) ? idx[pr.practitioner.reference] : null;
    var practName = humanName(pract), languages = langsOf(pract);
    var ipa = (pr.organization && pr.organization.reference && idx[pr.organization.reference]) ? (idx[pr.organization.reference].name || "") : "";
    // NOTE: no language filter here - build the FULL roster so the language facet is complete;
    // the selected language filter is applied at the end alongside specialty.
    [].concat(pr.location || []).forEach(function (lref) {
      var loc = lref && lref.reference ? idx[lref.reference] : null; if (!loc) return;
      var co = coordsFor(loc); if (!co) return;
      if (!REACH.withinReach(prof, radius, lat, lng, co.lat, co.lng)) return;
      var d = distM(lat, lng, co.lat, co.lng);
      var name = practName || cleanOrgName(loc.name) || "(In-network provider)";
      var lt = telOf(loc);
      var key = name.toLowerCase() + "|" + spec.toLowerCase();
      var ex = byName[key];
      if (ex && ex._d <= d) return; // keep the nearest location for this provider+specialty
      byName[key] = { name: name, specialty: spec, lat: co.lat, lng: co.lng, phone: prTel.phone || lt.phone || "", address: addrOf(loc), website: prTel.website || lt.website || "", inNetwork: true, approxByZip: co.approx, languages: languages, ipa: ipa, newPatients: newPt, npi: npiOf(pract), _addr: addrParts(loc), _d: d };
    });
  });
  var all = Object.keys(byName).map(function (k) { var r = byName[k]; delete r._d; return r; });
  all.sort(function (a, b) { return distM(lat, lng, a.lat, a.lng) - distM(lat, lng, b.lat, b.lng); });
  var specialties = facetSpecialties(all);               // data-driven specialty chips for THIS plan
  var languagesAvail = facetLanguages(all);              // data-driven language chips for THIS plan
  var sel = applyPreferred(all, specialty, language, prefer);
  var out = capped(sel.list, lat, lng, radius);
  return { ok: true, mode: "providers", specialty: specialty, specialtyApplied: sel.applied, language: language, specialties: specialties, languagesAvail: languagesAvail, approxByZip: out.some(function (p) { return p.approxByZip; }), count: sel.list.length, returned: out.length, uniqueProviders: all.length, rolesScanned: roles.length, truncated: truncated, places: out, query: debug ? queries : undefined };
}

// Serve a preprocessed JSON dataset (Health Net's directory, or Kaiser's facilities).
// ds.facilityOnly (Kaiser, a closed network): members get all care at these facilities, so
// specialty/care-type filtering doesn't apply - return the nearest facilities for any search.
function datasetSearch(ds, lat, lng, radius, type, specialty, language, prof, prefer) {
  if (!ds || !Array.isArray(ds.records)) return { ok: false, reason: "no-dataset" };
  var facilityOnly = !!ds.facilityOnly;
  // Doctor/specialty search (provider records) vs a specific care-type (place) search.
  var wantDoctors = !facilityOnly && (type === "doctor" || !!specialty || !!language);
  var CARECAT = { clinic: ["clinic"], hospital: ["hospital"], urgent_care: ["urgent_care"], mental_health: ["mental_health"], vision: ["vision"], dentist: ["dental", "dentist"] };
  var cats = (!facilityOnly && !wantDoctors) ? (CARECAT[type] || null) : null;
  function mk(r) {
    var addr = [r.address, r.city, r.state].filter(Boolean).join(", ") + (r.zip ? " " + r.zip : "");
    return { name: r.name, specialty: r.specialty || "", lat: r.lat, lng: r.lng, phone: r.phone, address: addr.trim(), website: "", inNetwork: true, approxByZip: !facilityOnly, languages: r.languages || [], ipa: r.ipa || "", newPatients: !!r.newPatients, _addr: { street: r.address || "", city: r.city || "", state: r.state || "CA", zip: r.zip || "" } };
  }
  var cand = [];
  for (var i = 0; i < ds.records.length; i++) {
    var r = ds.records[i];
    if (!isFinite(r.lat) || !isFinite(r.lng) || !REACH.withinReach(prof, radius, lat, lng, r.lat, r.lng)) continue;
    if (facilityOnly) { cand.push(mk(r)); continue; }
    if (wantDoctors) {
      if (r.cat !== "doctor") continue;                       // provider records only (no language filter yet - facet first)
      cand.push(mk(r));
    } else {
      if (!cats || cats.indexOf(r.cat) < 0) continue;
      cand.push(mk(r));
    }
  }
  cand.sort(function (a, b) { return distM(lat, lng, a.lat, a.lng) - distM(lat, lng, b.lat, b.lng); });
  // Specialty + language chips come straight from the dataset's own values (faceted from the full
  // roster), and the selected ones filter the same way as the FHIR path.
  var specialties = wantDoctors ? facetSpecialties(cand) : [];
  var languagesAvail = wantDoctors ? facetLanguages(cand) : [];
  var sel = wantDoctors ? applyPreferred(cand, specialty, language, prefer) : { list: cand, applied: false };
  var out = capped(sel.list, lat, lng, radius);
  return { ok: true, mode: facilityOnly ? "facilities" : (wantDoctors ? "providers" : "locations"), source: ds.plan === "kaiser" ? "kaiser" : "healthnet", facilityOnly: facilityOnly, specialties: specialties, languagesAvail: languagesAvail, approxByZip: !facilityOnly, refreshed: ds.generated || "", type: type, specialty: specialty, specialtyApplied: sel.applied, language: language, count: sel.list.length, returned: out.length, places: out };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  var q = req.query || {};
  var plan = String(q.plan || "");
  var lat = parseFloat(q.lat), lng = parseFloat(q.lng);
  var type = String(q.type || "clinic").toLowerCase();
  var specialty = String(q.specialty || "").trim();
  var language = String(q.language || "").trim();
  var zip = String(q.zip || "").trim();
  var radius = parseInt(q.radius || "8047", 10) || 8047;
  radius = Math.min(Math.max(radius, 500), 48000); // up to ~30 mi - covers a 30-min drive isochrone
  var debug = String(q.debug || "") === "1";
  // Optional radial profile of the client's reachable-area polygon (see api/_reach.js): searching
  // the real travel-time shape instead of the circle around it is what fills in the far edges.
  var prof = REACH.parseProfile(q.iso);
  var prefer = String(q.prefer || "") === "1"; // the specialty is the app's default, not the member's pick
  if (!isFinite(lat) || !isFinite(lng)) { res.status(400).json({ ok: false, error: "Missing coordinates" }); return; }

  var cfg = (ENDPOINTS.plans || {})[plan];
  if (!cfg || (!cfg.baseUrl && !cfg.dataset)) { res.status(200).json({ ok: false, reason: "no-endpoint", plan: plan }); return; }

  try {
    var result;
    if (cfg.dataset) {
      result = datasetSearch(HN, lat, lng, radius, type, specialty, language, prof, prefer);
      result = Object.assign({ plan: plan }, result);
    } else {
      var base = String(cfg.baseUrl).replace(/\/+$/, "");
      var geoMode = cfg.geo === "near" ? "near" : (cfg.geo === "postal-single" ? "postal-single" : "postal"); // default postal: most directories lack coordinates
      var km = Math.max(0.5, radius / 1000);
      // "Doctors" (type=doctor) uses provider mode with no specialty filter so EVERY in-network
      // doctor is returned and flagged - not just facility records (location mode = clinics).
      var wantProviders = !!(specialty || language || type === "doctor");
      var r0 = wantProviders ? await providerSearch(base, geoMode, lat, lng, km, radius, specialty, language, zip, debug, prof, prefer)
                             : await locationSearch(base, geoMode, lat, lng, km, radius, type, zip, debug, prof);
      // If provider/specialty mode returned nothing (some directories - IEHP, Molina - can't
      // filter PractitionerRole by location via the API), fall back to in-network LOCATIONS so
      // the map still shows in-network places to call.
      if (wantProviders && (!r0.ok || !r0.places || !r0.places.length)) {
        var rl = await locationSearch(base, geoMode, lat, lng, km, radius, "clinic", zip, debug, prof);
        if (rl.ok && rl.places && rl.places.length) { rl.specialtyUnavailable = true; r0 = rl; }
      }
      result = Object.assign({ source: "fhir", plan: plan, geo: geoMode, refreshed: "live" }, r0);
    }
    // Upgrade approximate ZIP-centroid pins to exact street coordinates (free Census
    // geocoder). Best-effort: failures keep the ZIP pin. Then drop the temp address field.
    if (result.ok && Array.isArray(result.places) && result.places.length) {
      try { await enrichFromNppes(result.places); } catch (e) { /* keep FHIR/ZIP coords */ }
      try { await censusGeocode(result.places); } catch (e) { /* keep ZIP-centroid coords */ }
      result.approxByZip = result.places.some(function (p) { return p.approxByZip; });
      result.geocoded = result.places.filter(function (p) { return !p.approxByZip; }).length;
      result.places = result.places.map(slim);
    }
    if (result.ok) res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json(result);
  } catch (e) {
    res.status(200).json({ ok: false, reason: "exception", plan: plan, detail: debug ? String((e && e.message) || e) : undefined });
  }
};
