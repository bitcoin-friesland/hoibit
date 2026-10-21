/**
 * Looks up an organization in OpenStreetMap: Overpass by phone, email and website,
 * Nominatim by name (once per region). Results from both are merged, deduplicated and ranked.
 */

export interface OsmResult {
  // "<osm_type>/<osm_id>", e.g. "node/123"
  id: string;
  osm_type: string;
  osm_id: number;
  class: string;
  type: string;
  name: string;
  address: {
    street: string;
    housenumber: string;
    postcode: string;
    city: string;
    region: string;
    country: string;
  };
  phone: string;
  website: string;
  email: string;
  tags: Record<string, string>;
  lat?: number | string;
  lon?: number | string;
  matchTypes?: MatchType[];
  [osmKey: string]: unknown;
}

type MatchType = "phone" | "email" | "website" | "name" | "other";

export interface OrganizationQuery {
  name: string;
  // e.g. provinces or cities; Nominatim is searched once per region, or once without a region if empty
  regions?: string[];
  // format: +31 ...
  phone?: string | null;
  website?: string | null;
  email?: string | null;
}

interface NominatimItem {
  osm_type: string;
  osm_id: number;
  class?: string;
  type?: string;
  display_name?: string;
  // The place's own name; display_name adds the whole address to it.
  namedetails?: { name?: string };
  address?: Record<string, string>;
  extratags?: Record<string, string>;
  lat?: string;
  lon?: string;
  [key: string]: unknown;
}

interface OverpassElement {
  type: string;
  id: number;
  class?: string;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  [key: string]: unknown;
}

// Nominatim and Overpass require a real contact; this address reaches the team via mail-to-tg.
const USER_AGENT = "hoibit-telegram-crm/1.0 (info@bitcoinfriesland.com)";
const OSM_KEYS = "shop amenity office craft industrial tourism leisure healthcare religion farm landuse".split(" ");

// Nominatim's usage policy allows at most 1 request per second. Each caller reserves the next free
// slot synchronously, so calls are spaced by NOMINATIM_INTERVAL_MS even when they start at the same
// time. This holds within one isolate; separate isolates do not share it.
const NOMINATIM_INTERVAL_MS = 1000;
let nextNominatimSlot = 0;

async function waitForNominatimSlot() {
  const now = Date.now();
  const slot = Math.max(now, nextNominatimSlot);
  nextNominatimSlot = slot + NOMINATIM_INTERVAL_MS;
  if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
}

// OSM type tags worth showing (landuse only when it is farmland).
function extraFields(tags: Record<string, unknown> | undefined, item: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const key of OSM_KEYS) {
    const value = (tags && tags[key]) || item[key];
    if (key === "landuse" && value !== "farmland") continue;
    if (value) fields[key] = value;
  }
  return fields;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    console.debug("[OSM DEBUG] fetch error:", url, e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Search OSM objects via Nominatim by name and optionally region.
 * Returns results in the same format as Overpass.
 */
async function searchNominatimByNameAndRegion(name: string, region?: string | null): Promise<OsmResult[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", region ? `${name}, ${region}` : name);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", "10");
  url.searchParams.set("namedetails", "1");

  await waitForNominatimSlot();
  const res = await fetchWithTimeout(url.toString(), { headers: { "User-Agent": USER_AGENT } });
  if (!res || !res.ok) {
    if (res) console.debug("[OSM DEBUG] Nominatim fetch failed:", res.status, res.statusText);
    return [];
  }
  const data = await res.json<NominatimItem[]>();
  if (!Array.isArray(data) || data.length === 0) return [];

  return data.map(item => ({
    id: `${item.osm_type.toLowerCase()}/${item.osm_id}`,
    osm_type: item.osm_type.toLowerCase(),
    osm_id: item.osm_id,
    class: item.class || "",
    type: item.type || "",
    name: item.namedetails?.name || item.display_name?.split(",")[0] || "",
    address: {
      street: item.address?.road || "",
      housenumber: item.address?.house_number || "",
      postcode: item.address?.postcode || "",
      city: item.address?.city || item.address?.town || item.address?.village || "",
      region: item.address?.state || item.address?.province || "",
      country: item.address?.country || ""
    },
    phone: item.extratags?.phone || "",
    website: item.extratags?.website || "",
    email: item.extratags?.email || "",
    tags: item.extratags || {},
    lat: item.lat,
    lon: item.lon,
    ...extraFields(item.extratags, item)
  }));
}

async function searchOverpass({ phone, website, email }: OrganizationQuery): Promise<OsmResult[]> {
  const queries: string[] = [];
  if (phone) {
    const phoneFields = ["phone", "contact:phone", "telephone", "contact:mobile", "mobile"];
    for (const variant of generatePhoneVariants(phone)) {
      const pattern = toOverpassString(variant);
      for (const field of phoneFields) queries.push(`node["${field}"~"${pattern}"];`);
    }
  }
  for (const [key, value] of [
    ["website", website],
    ["email", email]
  ] as const) {
    if (!value) continue;
    const pattern = escapeForOverpass(value);
    queries.push(`node["${key}"~"${pattern}",i];way["${key}"~"${pattern}",i];relation["${key}"~"${pattern}",i];`);
  }
  if (queries.length === 0) return [];

  const query = `
[out:json][timeout:25];
(
  ${queries.join("\n")}
);
out body;
`;
  const res = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: `data=${encodeURIComponent(query)}`
  });
  if (!res || !res.ok) {
    if (res) console.debug("[OSM DEBUG] Overpass fetch failed:", res.status, res.statusText);
    return [];
  }
  const data = await res.json<{ elements?: OverpassElement[] }>();
  if (!data.elements || data.elements.length === 0) return [];

  // Deduplicate by type/id
  const unique = new Map(data.elements.map(el => [`${el.type}/${el.id}`, el]));
  return [...unique.values()].map(item => {
    const tags = item.tags || {};
    const matchTypes: MatchType[] = [];
    if (
      phone &&
      (matchesAnyPhoneVariant(tags.phone, phone) ||
        matchesAnyPhoneVariant(tags["contact:phone"], phone) ||
        matchesAnyPhoneVariant(tags.telephone, phone))
    ) {
      matchTypes.push("phone");
    }
    if (email && tags.email && tags.email.toLowerCase() === email.toLowerCase()) matchTypes.push("email");
    if (website && tags.website && normalizeUrl(tags.website) === normalizeUrl(website)) matchTypes.push("website");
    if (matchTypes.length === 0) matchTypes.push("other");
    return {
      id: `${item.type}/${item.id}`,
      osm_type: item.type,
      osm_id: item.id,
      class: item.class || "",
      type: item.type || "",
      name: tags.name || "",
      address: {
        street: tags["addr:street"] || "",
        housenumber: tags["addr:housenumber"] || "",
        postcode: tags["addr:postcode"] || "",
        city: tags["addr:city"] || "",
        region: tags["addr:region"] || tags["addr:province"] || "",
        country: tags["addr:country"] || ""
      },
      phone: tags.phone || "",
      website: tags.website || "",
      email: tags.email || "",
      tags,
      lat: item.lat || item.center?.lat,
      lon: item.lon || item.center?.lon,
      matchTypes,
      ...extraFields(tags, item)
    };
  });
}

// Searches Nominatim by name for each region in turn; waitForNominatimSlot spaces the requests.
async function searchNominatimByName(name: string, regions: (string | null)[]): Promise<OsmResult[]> {
  const results: OsmResult[] = [];
  for (const region of regions) results.push(...(await searchNominatimByNameAndRegion(name, region)));
  return results;
}

export async function findOsmNodeForOrganization(query: OrganizationQuery): Promise<OsmResult[]> {
  const { name, phone, website, email } = query;
  const regions = query.regions && query.regions.length > 0 ? [...new Set(query.regions)] : [null];

  // 1. Phone, email and website via Overpass (once: the query does not depend on the region),
  //    alongside 2. name via Nominatim, one region after another.
  const [overpassResults, nominatimFound] = await Promise.all([
    searchOverpass(query),
    name ? searchNominatimByName(name, regions) : Promise.resolve([])
  ]);
  const nominatimResults = nominatimFound.map(item => {
    const matchTypes: MatchType[] = ["name"];
    if (phone && matchesAnyPhoneVariant(item.phone, phone)) matchTypes.push("phone");
    if (email && item.email && item.email.toLowerCase() === email.toLowerCase()) matchTypes.push("email");
    if (website && item.website && normalizeUrl(item.website) === normalizeUrl(website)) {
      matchTypes.push("website");
    }
    return { ...item, matchTypes };
  });

  // 3. Combine results by id (the same place can come from Overpass and from several regions), merging matchTypes
  const combined = new Map<string, OsmResult>();
  for (const item of overpassResults) combined.set(item.id, { ...item });
  for (const item of nominatimResults) {
    const existing = combined.get(item.id);
    if (existing) {
      const mergedTypes = [...new Set([...(existing.matchTypes || []), ...item.matchTypes])];
      combined.set(item.id, { ...existing, ...item, matchTypes: mergedTypes });
    } else {
      combined.set(item.id, { ...item });
    }
  }

  // 4. Sort: results with more matchTypes first, then by best matchType
  const matchTypeOrder: Record<MatchType, number> = { phone: 1, email: 2, website: 3, name: 4, other: 5 };
  const best = (item: OsmResult) => Math.min(99, ...(item.matchTypes || []).map(t => matchTypeOrder[t] || 99));
  return [...combined.values()].sort(
    (a, b) => (b.matchTypes?.length || 0) - (a.matchTypes?.length || 0) || best(a) - best(b)
  );
}

// Whether any of the (;-separated) OSM phone numbers matches the input phone number.
function matchesAnyPhoneVariant(osmPhone: string | undefined, inputPhone: string) {
  if (!osmPhone) return false;
  const variants = generatePhoneVariants(inputPhone).map(variant => new RegExp(variant));
  return osmPhone
    .split(";")
    .map(p => p.trim())
    .some(phone => variants.some(re => re.test(phone)));
}

// Normalize url (without trailing slash, lowercased)
function normalizeUrl(url: string) {
  try {
    return new URL(url).href.replace(/\/$/, "").toLowerCase();
  } catch {
    return (url || "").replace(/\/$/, "").toLowerCase();
  }
}

// Matches value literally inside a double-quoted Overpass regex: escape the regex
// metacharacters, then escape backslashes and quotes for the Overpass string.
export function escapeForOverpass(value: string) {
  return toOverpassString(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

// ITU E.164 country calling codes, longest first so "+353" is not read as "+35".
// Source: https://www.itu.int/itudoc/itu-t/ob-lists/icc/e164_763.html and other public sources
const COUNTRY_CODES = (
  "1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 " +
  "81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 " +
  "233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 " +
  "260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 " +
  "371 372 373 374 375 376 377 378 379 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 " +
  "506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 " +
  "683 685 686 687 688 689 690 691 692 850 852 853 855 856 870 871 872 873 874 878 880 881 882 883 886 888 " +
  "960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 997 998 999"
)
  .split(" ")
  .sort((a, b) => b.length - a.length);

// Escapes backslashes and quotes so a regex can go inside a double-quoted Overpass string.
function toOverpassString(regex: string) {
  return regex.replace(/[\\"]/g, "\\$&");
}

/**
 * JavaScript regex source for a phone number in OSM tags: (\+|00)<countrycode> followed by each
 * remaining digit with .* in between, so any notation matches. Overpass queries need it passed
 * through toOverpassString first.
 * Example: "+31 515 433154" → ["(\+|00)31.*5.*1.*5.*4.*3.*3.*1.*5.*4"]
 */
function generatePhoneVariants(phone: string): string[] {
  let normalized = phone.replace(/[^\d+]/g, "");
  if (normalized.startsWith("00")) normalized = "+" + normalized.slice(2);
  if (!normalized.startsWith("+")) return [];

  const countryCode = COUNTRY_CODES.find(code => normalized.startsWith("+" + code));
  if (!countryCode) return [];
  const rest = normalized.slice(1 + countryCode.length);
  if (rest.length < 1) return [];

  let pattern = `(\\+|00)` + countryCode;
  for (const digit of rest) pattern += `.*${digit}`;
  return [pattern];
}
