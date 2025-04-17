/**
 * Helper for searching an OSM node id based on organization data.
 * Uses the Overpass API from OpenStreetMap.
 *
 * @param {Object} params
 * @param {string} params.name - Organization name
 * @param {string} [params.region] - Region (optional, e.g. province or city)
 * @param {string} [params.phone] - Phone number (format: +31 ...)
 * @param {string} [params.website] - Website (optional)
 * @param {string} [params.email] - Email address (optional)
 * @returns {Promise<Object|null>} OSM node/way/relation object or null if not found
 */
let lastOverpassRequest = 0;

/**
 * Helper for searching an OSM node id based on organization data.
 * Uses the Overpass API from OpenStreetMap.
 *
 * @param {Object} params
 * @param {string} params.name - Organization name
 * @param {string} [params.region] - Region (optional, e.g. province or city)
 * @param {string} [params.phone] - Phone number (format: +31 ...)
 * @param {string} [params.website] - Website (optional)
 * @param {string} [params.email] - Email address (optional)
 * @returns {Promise<Object|null>} OSM node/way/relation object or null if not found
 */
/**
 * Search OSM objects via Nominatim by name and optionally region.
 * Returns results in the same format as Overpass.
 */
async function searchNominatimByNameAndRegion(name, region) {
  // Nominatim API endpoint
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", region ? `${name}, ${region}` : name);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("limit", "10");
  url.searchParams.set("namedetails", "1");

  console.debug("[OSM DEBUG] Nominatim fetch URL:", url.toString());
  // Add fetch timeout (15s)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "crm-btc/1.0 (contact@btc.com)"
      },
      signal: controller.signal
    });
  } catch (e) {
    console.debug("[OSM DEBUG] Nominatim fetch error:", e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    console.debug("[OSM DEBUG] Nominatim fetch failed:", res.status, res.statusText);
    return [];
  }
  const data = await res.json();
  console.debug("[OSM DEBUG] Nominatim raw response:", JSON.stringify(data, null, 2));
  if (!Array.isArray(data) || data.length === 0) return [];

  // Map Nominatim results to Overpass-like format
  return data.map(item => {
    // OSM keys to extract
    const osmKeys = [
      "shop", "amenity", "office", "craft", "industrial", "tourism", "leisure", "healthcare", "religion", "farm", "landuse"
    ];
    const extraFields = {};
    for (const key of osmKeys) {
      // Prefer extratags, fallback to root
      let value = (item.extratags && item.extratags[key]) || item[key];
      if (key === "landuse" && value !== "farmland") continue;
      if (value) extraFields[key] = value;
    }
    return {
      id: `${item.osm_type.toLowerCase()}/${item.osm_id}`,
      osm_type: item.osm_type.toLowerCase(),
      osm_id: item.osm_id,
      class: item.class || "",
      type: item.type || "",
      name: item.display_name || "",
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
      ...extraFields
    };
  });
}

export async function findOsmNodeForOrganization({ name, region, phone, website, email }) {
  // Throttle: ensure at least 1s between Overpass requests
  const now = Date.now();
  const wait = 1000 - (now - lastOverpassRequest);
  if (wait > 0) await new Promise(res => setTimeout(res, wait));
  lastOverpassRequest = Date.now();

  // 1. Search by phone, email, website via Overpass (first)
  let overpassResults = [];
  let queries = [];
  if (phone) {
    const phoneVariants = generatePhoneVariants(phone);
    const phoneFields = ["phone", "contact:phone", "telephone", "contact:mobile", "mobile"];
    for (const variant of phoneVariants) {
      for (const field of phoneFields) {
        queries.push(`node["${field}"~"${variant}"];`);
      }
    }
  }
  if (website) queries.push(`node["website"~"${escapeForOverpass(website)}",i];way["website"~"${escapeForOverpass(website)}",i];relation["website"~"${escapeForOverpass(website)}",i];`);
  if (email) queries.push(`node["email"~"${escapeForOverpass(email)}",i];way["email"~"${escapeForOverpass(email)}",i];relation["email"~"${escapeForOverpass(email)}",i];`);

  if (queries.length > 0) {
    const query = `
[out:json][timeout:25];
(
  ${queries.join('\n')}
);
out body;
`;
    const url = "https://overpass-api.de/api/interpreter";
    console.debug("[OSM DEBUG] Overpass fetch URL:", url);
    console.debug("[OSM DEBUG] Overpass query body:", query);
    // Add fetch timeout (15s)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "crm-btc/1.0 (contact@btc.com)"
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal
      });
    } catch (e) {
      console.debug("[OSM DEBUG] Overpass fetch error:", e);
      // Return empty results on error
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      console.debug("[OSM DEBUG] Overpass fetch failed:", res.status, res.statusText);
    }
    if (res.ok) {
      const data = await res.json();
      console.debug("[OSM DEBUG] Overpass raw response:", JSON.stringify(data, null, 2));
      if (data.elements && data.elements.length > 0) {
        // Deduplicate by type/id
        const unique = {};
        for (const el of data.elements) {
          unique[`${el.type}/${el.id}`] = el;
        }
        overpassResults = Object.values(unique).map(item => {
          // Determine matchTypes (array)
          let matchTypes = [];
          if (phone && (
            (item.tags?.phone && matchesAnyPhoneVariant(item.tags.phone, phone)) ||
            (item.tags?.["contact:phone"] && matchesAnyPhoneVariant(item.tags["contact:phone"], phone)) ||
            (item.tags?.telephone && matchesAnyPhoneVariant(item.tags.telephone, phone))
          )) {
            matchTypes.push("phone");
          }
          if (email && item.tags?.email && item.tags.email.toLowerCase() === email.toLowerCase()) {
            matchTypes.push("email");
          }
          if (website && item.tags?.website && normalizeUrl(item.tags.website) === normalizeUrl(website)) {
            matchTypes.push("website");
          }
          if (matchTypes.length === 0) matchTypes.push("other");
          console.debug("[OSM DEBUG] Overpass matchType input:", {
            tags: item.tags,
            phone, email, website
          });
          console.debug("[OSM DEBUG] Overpass matchTypes result:", matchTypes);
          // OSM keys to extract
          const osmKeys = [
            "shop", "amenity", "office", "craft", "industrial", "tourism", "leisure", "healthcare", "religion", "farm", "landuse"
          ];
          const extraFields = {};
          for (const key of osmKeys) {
            let value = (item.tags && item.tags[key]) || item[key];
            if (key === "landuse" && value !== "farmland") continue;
            if (value) extraFields[key] = value;
          }
          const result = {
            id: `${item.type}/${item.id}`,
            osm_type: item.type,
            osm_id: item.id,
            class: item.class || "",
            type: item.type || "",
            name: item.tags?.name || "",
            address: {
              street: item.tags?.['addr:street'] || "",
              housenumber: item.tags?.['addr:housenumber'] || "",
              postcode: item.tags?.['addr:postcode'] || "",
              city: item.tags?.['addr:city'] || "",
              region: item.tags?.['addr:region'] || item.tags?.['addr:province'] || "",
              country: item.tags?.['addr:country'] || ""
            },
            phone: item.tags?.phone || "",
            website: item.tags?.website || "",
            email: item.tags?.email || "",
            tags: item.tags || {},
            lat: item.lat || item.center?.lat,
            lon: item.lon || item.center?.lon,
            matchTypes,
            ...extraFields
          };
          console.debug("[OSM DEBUG] Overpass result:", result);
          return result;
        });
      }
    }
  }

  // 2. Search by name (and region) via Nominatim
  let nominatimResults = [];
  if (name) {
    const nominatimRaw = await searchNominatimByNameAndRegion(name, region);
    nominatimResults = nominatimRaw.map(item => {
      let matchTypes = ["name"];
      if (phone && matchesAnyPhoneVariant(item.phone, phone)) matchTypes.push("phone");
      if (email && item.email && item.email.toLowerCase() === email.toLowerCase()) matchTypes.push("email");
      if (website && item.website && normalizeUrl(item.website) === normalizeUrl(website)) matchTypes.push("website");
      return {
        ...item,
        matchTypes
      };
    });
  }

  // 3. Combine results by id, merging matchTypes
  const combined = {};
  for (const item of overpassResults) {
    combined[item.id] = { ...item };
  }
  for (const item of nominatimResults) {
    if (combined[item.id]) {
      // Merge matchTypes, deduplicate
      const mergedTypes = Array.from(new Set([...(combined[item.id].matchTypes || []), ...(item.matchTypes || [])]));
      combined[item.id] = { ...combined[item.id], ...item, matchTypes: mergedTypes };
    } else {
      combined[item.id] = { ...item };
    }
  }

  // 4. Sort: results with >1 matchType first, then by matchType priority
  const matchTypeOrder = { phone: 1, email: 2, website: 3, name: 4, other: 5 };
  const sorted = Object.values(combined).sort((a, b) => {
    // More matchTypes = higher priority
    if ((b.matchTypes?.length || 0) !== (a.matchTypes?.length || 0)) {
      return (b.matchTypes?.length || 0) - (a.matchTypes?.length || 0);
    }
    // Otherwise, sort by best matchType
    const aBest = (a.matchTypes || []).map(t => matchTypeOrder[t] || 99).sort()[0] || 99;
    const bBest = (b.matchTypes || []).map(t => matchTypeOrder[t] || 99).sort()[0] || 99;
    return aBest - bBest;
  });

  return sorted;
}

// Helper: check if a phone number matches any of the variants
function matchesAnyPhoneVariant(osmPhone, inputPhone) {
  if (!osmPhone) {
    return false;
  }
  const variants = generatePhoneVariants(inputPhone);
  // OSM phone can contain multiple numbers, separated by ;
  const phones = osmPhone.split(";").map(p => p.trim());
  for (const phone of phones) {
    for (const variant of variants) {
      const re = new RegExp(variant);
      const result = re.test(phone);
      if (result) return true;
    }
  }
  return false;
}

// Helper: normalize url (without trailing slash, lowercased)
function normalizeUrl(url) {
  try {
    return new URL(url).href.replace(/\/$/, "").toLowerCase();
  } catch {
    return (url || "").replace(/\/$/, "").toLowerCase();
  }
}

/**
 * Generate regex variant for a phone number for Overpass queries.
 * Uses (\\+|00)<countrycode>.*<digit>.*<digit>... for maximum flexibility.
 * Example: "+31515433154" or "+31 515 433154" → ["(\\+|00)31.*5.*1.*5.*4.*3.*3.*1.*5.*4"]
 * This matches worldwide notations and is used for all phone fields including "contact:mobile" and "mobile".
 */
function generatePhoneVariants(phone) {
  // Remove all non-numeric characters except +
  let normalized = phone.replace(/[^\d+]/g, "");
  // Replace 00 at the start with +
  if (normalized.startsWith("00")) {
    normalized = "+" + normalized.slice(2);
  }
  // Only keep + and digits
  if (!normalized.startsWith("+")) return [];

  // Full ITU E.164 country calling codes (sorted by length descending for correct matching)
  // Source: https://www.itu.int/itudoc/itu-t/ob-lists/icc/e164_763.html and other public sources
  const countryCodes = [
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
    "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90",
    "91", "92", "93", "94", "95", "98", "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225", "226",
    "227", "228", "229", "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243",
    "244", "245", "246", "247", "248", "249", "250", "251", "252", "253", "254", "255", "256", "257", "258", "260", "261",
    "262", "263", "264", "265", "266", "267", "268", "269", "290", "291", "297", "298", "299", "350", "351", "352", "353",
    "354", "355", "356", "357", "358", "359", "370", "371", "372", "373", "374", "375", "376", "377", "378", "379", "380",
    "381", "382", "383", "385", "386", "387", "389", "420", "421", "423", "500", "501", "502", "503", "504", "505", "506",
    "507", "508", "509", "590", "591", "592", "593", "594", "595", "596", "597", "598", "599", "670", "672", "673", "674",
    "675", "676", "677", "678", "679", "680", "681", "682", "683", "685", "686", "687", "688", "689", "690", "691", "692",
    "850", "852", "853", "855", "856", "870", "871", "872", "873", "874", "878", "880", "881", "882", "883", "886", "888",
    "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975", "976", "977",
    "992", "993", "994", "995", "996", "997", "998", "999"
  ].sort((a, b) => b.length - a.length);

  let countryCode = null;
  let rest = null;
  for (const code of countryCodes) {
    if (normalized.startsWith("+" + code)) {
      countryCode = code;
      rest = normalized.slice(1 + code.length);
      break;
    }
  }
  if (!countryCode || !rest || rest.length < 1) return [];

  // Each digit after the country code gets its own .*
  let pattern = `(\\\\+|00)` + countryCode;
  for (const digit of rest) {
    pattern += `.*${digit}`;
  }
  return [pattern];
}
