/* Build the website data bundle (js/data.js) from the JSON "database" in /data.
 The /data JSON files are the single source of truth. Run: node scripts/build-data.mjs
 The site reads window.AM_DATA so it works by simply opening index.html (no server). */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const read = (...p) => JSON.parse(readFileSync(join(dataDir, ...p), "utf8"));

const meta = read("meta.json");
const index = read("index.json");
const barriersDoc = read("barriers.json");
const stateDoc = read("state-resources.json");
const fhirDoc = read("fhir-endpoints.json");

// Plan ids with a usable public FHIR Provider Directory endpoint (true live FHIR).
const fhirPlans = Object.keys(fhirDoc.plans || {}).filter(
 (id) => (fhirDoc.plans[id] && fhirDoc.plans[id].baseUrl || "").length > 0
);
// Closed-network brands (e.g. Kaiser): no usable public FHIR directory, but the plan is a
// closed network, so its in-network facilities are exactly the brand-named ones - the client
// plots those from public map data and marks them in-network. id -> brand search string.
const closedNetworkBrands = {};
Object.keys(fhirDoc.plans || {}).forEach((id) => {
 const b = fhirDoc.plans[id] && fhirDoc.plans[id].closedNetworkBrand;
 if (b) closedNetworkBrands[id] = b;
});
// All plans the map can show in-network results for: FHIR endpoints + any plan with a
// preprocessed dataset file present (e.g. Health Net) + closed-network brands. The client uses
// this to gate the search, show the in-network badge, and offer specialty/language filters.
const inNetworkPlans = Object.keys(fhirDoc.plans || {}).filter((id) => {
 const p = fhirDoc.plans[id] || {};
 if ((p.baseUrl || "").length > 0) return true;
 if (p.dataset && existsSync(join(dataDir, p.dataset))) return true;
 if (p.closedNetworkBrand) return true;
 return false;
});

// Flatten the grouped manifest into an ordered plan list, attaching the
// service area (county) and brand-accent color to each plan.
const planRefs = index.groups.flatMap((g) =>
 g.plans.map((pl) => ({ id: pl.id, color: pl.color, serviceArea: g.area }))
);

const plans = planRefs.map((ref) => {
 const p = read("plans", ref.id + ".json");
 // The site reads `id`/`name`; the database uses `planId`/`planName`. Provide both.
 return Object.assign({ id: p.planId, name: p.planName, serviceArea: ref.serviceArea, brandColor: ref.color }, p);
});

const serviceAreas = index.groups.map((g) => g.area);

// "Last updated" is stamped automatically at BUILD time (this script runs on every deploy and on
// the weekly cron's refresh), so the date always reflects the latest data refresh rather than a
// stale hand-edited value. We take the most recent of the build date and the Health Net dataset's
// own refresh date so the label never lags the in-network data.
const buildDate = new Date().toISOString().slice(0, 10);
let hnGenerated = "";
try { hnGenerated = (read("healthnet-providers.json").generated || "").slice(0, 10); } catch (_) {}
const lastUpdated = [buildDate, hnGenerated].filter(Boolean).sort().pop();

const bundle = {
 meta: { lastUpdated, region: index.region, county: meta.county, h1Note: meta.h1Note || "" },
 categories: meta.categories,
 serviceAreas,
 plans,
 barriers: barriersDoc.barriers,
 stateResources: stateDoc.resources,
 stateSources: stateDoc.sources || [],
 barrierSources: barriersDoc.sources || [],
 fhirPlans,
 inNetworkPlans,
 closedNetworkBrands,
};

const banner = "/* AUTO-GENERATED from /data by scripts/build-data.mjs - do not edit by hand. */\n";
writeFileSync(
 join(root, "js", "data.js"),
 banner + "window.AM_DATA = " + JSON.stringify(bundle, null, 2) + ";\n",
 "utf8"
);

const resourceCount =
 plans.reduce((n, p) => n + (p.resources ? p.resources.length : 0), 0) + stateDoc.resources.length;
console.log(
 `Wrote js/data.js - ${plans.length} plans, ${barriersDoc.barriers.length} barriers, ` +
 `${stateDoc.resources.length} statewide resources, ${resourceCount} total resource cards.`
);
