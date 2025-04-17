import { isValidName, isValidEmail, isValidPhone } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, promptWithSkip, promptWithOptions } from "../helpers/messaging.js";
import { selectCommunities, fetchCountries, fetchCommunitiesByCountry, selectCommunitiesList } from "../helpers/community.js";
import { findOsmNodeForOrganization } from "../helpers/osm.js";

/**
 * Returns a formatted OSM type tag string for given tags, or null if not found.
 */
export async function handleContactFlow(sendMessage, env, chatId, text, session, persistSession = async () => {}, removeSession = async () => {}) {
  const OSM_TYPE_KEYS = [
    "shop", "amenity", "office", "craft", "industrial", "tourism", "leisure", "healthcare", "religion", "farm", "landuse"
  ];
  function getOsmTypeTag(tags) {
    if (!tags) return null;
    for (const key of OSM_TYPE_KEYS) {
      if (tags[key]) {
        if (key === "landuse" && tags[key] !== "farmland") continue;
        if (key !== "landuse" || tags[key] === "farmland") {
          return `*Type:* ${key} = ${tags[key]}`;
        }
      }
    }
    return null;
  }

  switch (session.step) {
    case "awaiting_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid contact name (minimum 3 letters, only alphabetic)."));
        return;
      }
      session.name = name;
      setStep(session, "awaiting_email");
      await persistSession();
      const prompt = promptWithSkip("What is the email address of the contact? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_email": {
      let email = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        email = null;
      } else if (email && !isValidEmail(email) && email.length > 0) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid email address or tap Skip."));
        return;
      }
      session.email = (email && email.toLowerCase() !== "skip") ? email : null;
      setStep(session, "awaiting_phone");
      await persistSession();
      const prompt = promptWithSkip("What is the phone number of the contact? (must start with + or 00, optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_phone": {
      let phone = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        phone = null;
      } else if (phone && !isValidPhone(phone)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid phone number starting with + or 00, or tap Skip."));
        return;
      }
      session.phone = (phone && phone.toLowerCase() !== "skip") ? phone : null;
      setStep(session, "awaiting_nostr");
      await persistSession();
      const prompt = promptWithSkip("What is the nostr npub of the contact? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_nostr": {
      let nostr = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        nostr = null;
      }
      session.nostr_npub = (nostr && nostr.toLowerCase() !== "skip") ? nostr : null;
      setStep(session, "awaiting_type");
      await persistSession();
      const types = [
        { label: "Consumer", value: "consumer" },
        { label: "Entrepreneur", value: "entrepreneur" }
      ];
      const prompt = promptWithOptions("What type of contact is this?", types);
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_type": {
      let type = text;
      if (!type && session.last_callback_data) {
        type = session.last_callback_data;
      }
      if (!type || (type !== "consumer" && type !== "entrepreneur")) {
        await sendMessage(env, chatId, errorMessage("Please select a valid type."));
        return;
      }
      session.type = type;
      if (session.type === "entrepreneur") {
        setStep(session, "awaiting_organization");
        await persistSession();
        await sendMessage(env, chatId, "Which organization is this contact linked to? (required, type part of the name to search or create a new one)");
        return;
      } else {
        // Persist consumer contact
        try {
          await env.crmApi.fetch(new Request(
            `${env.CRM_API_URL}/newcontact`,
            {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                name: session.name,
                type: session.type,
                email: session.email || null,
                phone: session.phone || null,
                nostr_npub: session.nostr_npub || null,
                created_by: session.telegram_id || null,
              })
            }
          ));
        } catch (e) {}
        await sendMessage(env, chatId, "Contact added (consumer flow end).");
        await removeSession();
      }
      break;
    }
    case "awaiting_organization": {
      if (session.last_callback_data === "search_org_again") {
        session.last_callback_data = null;
        await persistSession();
        await sendMessage(env, chatId, "Which organization is this contact linked to?\nType part of the name.");
        return;
      }
      const org =
        (text && text.trim()) ||
        (session.last_callback_data
          ? (
            session.last_callback_data.startsWith("confirm_org:") ? session.last_callback_data.replace("confirm_org:","")
            : session.last_callback_data.startsWith("select_org:") ? session.last_callback_data.replace("select_org:","")
            : null)
          : null);
      if (!org || /^\d+$/.test(org) || /@/.test(org) || /[^a-zA-Z0-9\s&\-,.'"]/g.test(org)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid organization name (organization names should be words, not a phone number or symbols)."));
        return;
      }
      if (
        (session.last_callback_data && session.last_callback_data.startsWith("confirm_org:")) ||
        (session.last_callback_data && session.last_callback_data.startsWith("select_org:"))
      ) {
        session.organization = org;
        setStep(session, "awaiting_org_website");
        await persistSession();
        const prompt = promptWithSkip("What is the website of the organization? (optional)");
        await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
        return;
      }
      try {
        const searchRes = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/organizations/search?name=${encodeURIComponent(org)}`,
          { method: "GET", headers: { "Authorization": `Bearer ${env.API_TOKEN}` } }
        ));
        if (searchRes.ok) {
          const data = await searchRes.json();
          const orgs = Array.isArray(data) ? data : data.orgs || [];
          if (orgs.length > 0) {
            const keyboard = orgs.slice(0, 5).map(o => [{ text: o.name, callback_data: `select_org:${o.name}` }]);
            keyboard.push([{ text: `Create new "${org}"`, callback_data: `confirm_org:${org}` }]);
            await sendMessage(env, chatId, "Select an existing organization or create new:", {
              reply_markup: { inline_keyboard: keyboard }
            });
            session.last_callback_data = null;
            await persistSession();
            return;
          } else {
            await sendMessage(env, chatId, `No organization found with the name "${org}".`, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: `Confirm and create "${org}"`, callback_data: `confirm_org:${org}` }],
                  [{ text: "Search again", callback_data: "search_org_again" }]
                ]
              }
            });
            session.last_callback_data = null;
            await persistSession();
            return;
          }
        } else {
          await sendMessage(env, chatId, errorMessage(`Error searching organizations (code ${searchRes.status})`));
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage(`Exception during org search: ${e && e.message ? e.message : e}`));
      }
      await persistSession();
      break;
    }
    case "awaiting_org_website": {
      let website = text && text.trim();
      if (session.last_callback_data === "skip") {
        website = null;
      }
      session.organization_website = website || null;

      // Skip OSM lookup here; do it after community selection
      setStep(session, "awaiting_communities");
      await persistSession();
      // Start community selection
      await selectCommunities({
        sendMessage,
        env,
        chatId,
        session,
        persistSession,
        removeSession,
        userId: session.telegram_id,
        onComplete: async (communities) => {
          session.selected_communities = communities;
          // Determine region from first selected community (fallback to org name if none)
          let region = null;
          if (communities && communities.length > 0) {
            // communities is an array of objects or ids; fetch full object if needed
            const comm = typeof communities[0] === "object" ? communities[0] : null;
            region = comm?.region || comm?.name || comm?.city || comm?.country || null;
            if (!region && typeof communities[0] === "string") {
              // Try to fetch community object if only id is present
              const allComms = await selectCommunitiesList(env, session.telegram_id);
              const found = allComms.find(c => String(c.id) === String(communities[0]));
              region = found?.name || found?.city || found?.country || null;
            }
          }
          // Gather org info
          const orgName = session.organization;
          let phone = session.phone;
          const orgWebsite = session.organization_website;
          const email = session.email;

          // Telefoonnummer formatteren naar internationaal formaat
          if (phone) {
            phone = formatPhoneNumber(phone);
          }

          // Show loader before OSM lookup
          await sendMessage(env, chatId, "Searching for OpenStreetMap locations... ⏳");

      // OSM lookup
      let osmResults = [];
      try {
        osmResults = await findOsmNodeForOrganization({
          name: orgName,
          region,
          phone,
          website: orgWebsite,
          email
        });
      } catch (e) {
        osmResults = [];
      }

      // Ensure item.class and item.type are set for Overpass results
      setOsmClassAndTypeFromTags(osmResults);

      // Ask user to select OSM node if results found
      if (osmResults.length > 0) {
        // Build details message and buttons
        const maxResults = 8;

const detailsList = osmResults.slice(0, maxResults).map((item) => {
  const typeTag = getOsmTypeTag(item.tags);
  let osmTypeLine = "";
  if (item.class && item.type) {
    osmTypeLine = `*OSM type:* ${item.class} = ${item.type}\n`;
  } else if (item.tags) {
    for (const key of OSM_TYPE_KEYS) {
      if (item.tags[key]) {
        osmTypeLine = `*OSM type:* ${key} = ${item.tags[key]}\n`;
        break;
      }
    }
  }
  // Show all relevant OSM tags
  let tagLines = "";
  if (item.tags) {
    tagLines = OSM_TYPE_KEYS
      .filter(key => item.tags[key])
      .map(key => `*Tag:* ${key} = ${item.tags[key]}\n`)
      .join("");
  }
  // Always show Nominatim class/type if present
  let nominatimLine = "";
  if (item.class && item.type) {
    nominatimLine = `*Nominatim class/type:* ${item.class} = ${item.type}\n`;
  }
  return (
    `# ${item.osm_id}\n` +
    `*Name:* ${item.name || "(no name)"}\n` +
    osmTypeLine +
    tagLines +
    nominatimLine +
    (typeTag ? `${typeTag}\n` : "") +
    `*Address:* ${[
      item.address.street,
      item.address.housenumber,
      item.address.postcode,
      item.address.city,
      item.address.region,
      item.address.country
    ].filter(Boolean).join(", ")}\n` +
    (item.phone ? `*Phone:* ${item.phone}\n` : "") +
    (item.email ? `*Email:* ${item.email}\n` : "") +
    (item.website ? `*Website:* ${item.website}\n` : "")
  );
}).join("\n\n");

const keyboard = osmResults.slice(0, maxResults).map((item) => [{
  text: `# ${item.osm_id}`,
  callback_data: `osmnode:${item.id}`
}]);
keyboard.push([{ text: "None of the above", callback_data: "osmnode:none" }]);

await sendMessage(
  env,
  chatId,
  `Select the correct OpenStreetMap location for this organization:\n\n${detailsList}`,
  {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "Markdown"
  }
);
            setStep(session, "awaiting_osm_node");
            await persistSession();
            return;
          } else {
            // No OSM results, continue
            setStep(session, "done");
            await persistSession();
            await sendMessage(env, chatId, "Communities saved. Contact added. (No OSM location found.)");
            await removeSession();
          }
        },
        onSkip: async () => {
          setStep(session, "done");
          await persistSession();
          await sendMessage(env, chatId, "No communities selected. Contact added.");
          await removeSession();
        },
        context: "contact"
      });
      break;
    }
    case "awaiting_communities": {
      // Multi-select communities
      if (!session.selected_communities) session.selected_communities = [];

      const cb = session.last_callback_data;

      // Handle skip
      if (cb === "skip") {
        setStep(session, "done");
        await persistSession();
        await sendMessage(env, chatId, "No communities selected. Contact added.");
        await removeSession();
        return;
      }

      // Handle confirm selection
      if (cb === "confirm_communities") {
        // After confirmation, do OSM lookup and selection
        let regions = [];
        if (session.selected_communities && session.selected_communities.length > 0) {
          const allComms = await selectCommunitiesList(env, session.telegram_id);
          const selectedComms = allComms.filter(c => session.selected_communities.includes(String(c.id)));
          regions = selectedComms
            .map(c => c.region)
            .filter(Boolean);
        }
        const orgName = session.organization;
        let phone = session.phone;
        const orgWebsite = session.organization_website;
        const email = session.email;

        // Telefoonnummer formatteren naar internationaal formaat
        if (phone) {
          phone = formatPhoneNumber(phone);
        }

        // Debug: log OSM search parameters

        // Show loader before OSM lookup
        await sendMessage(env, chatId, "Searching for OpenStreetMap locations... ⏳");

      let osmResults = [];
      try {
        if (regions.length > 0) {
          // Zoek per regio, bundel resultaten
          const resultsPerRegion = await Promise.all(
            regions.map(region =>
              findOsmNodeForOrganization({
                name: orgName,
                region,
                phone,
                website: orgWebsite,
                email
              })
            )
          );
          osmResults = resultsPerRegion.flat();

          // Debug output: toon aantal resultaten per regio
          resultsPerRegion.forEach((result, idx) => {
          });
        } else {
          // Geen regio's, doe een enkele zoekopdracht zonder regio
          osmResults = await findOsmNodeForOrganization({
            name: orgName,
            region: null,
            phone,
            website: orgWebsite,
            email
          });
        }
      } catch (e) {
        osmResults = [];
      }

      // Ensure item.class and item.type are set for Overpass results
      setOsmClassAndTypeFromTags(osmResults);

/**
 * Sets item.class and item.type for OSM results if either is missing or incorrect, using known OSM type keys.
 * If a known OSM_TYPE_KEY exists in tags, both item.class and item.type are set to the key and value.
 * This ensures the OSM type line is always shown in the chat output for all OSM results.
 */
function setOsmClassAndTypeFromTags(osmResults) {
  const OSM_TYPE_KEYS = [
    "shop", "amenity", "office", "craft", "industrial", "tourism", "leisure", "healthcare", "religion", "farm", "landuse"
  ];
  osmResults.forEach(item => {
    if (item.tags) {
      for (const key of OSM_TYPE_KEYS) {
        if (item.tags[key]) {
          if (item.class !== key || item.type !== item.tags[key]) {
            item.class = key;
            item.type = item.tags[key];
          }
          break;
        }
      }
    }
  });
}

/**
 * Formats a phone number to international format: +[country code] [area code] [rest]
 * Works generically for all countries, without specific area code lists.
 * - Removes spaces, dashes, dots, parentheses.
 * - Converts 00 at the start to +.
 * - Converts 0 at the start to +[defaultCountryCode] (optional, default +31).
 * - Splits into country code, area code (first 1-4 digits after country code), rest.
 * - Result: +[country code] [area code] [rest] (with spaces).
 */
function formatPhoneNumber(input, defaultCountryCode = "31") {
  if (!input) return input;
  let phone = input.replace(/[\s\-\.\(\)]/g, ""); // remove spaces, dashes, dots, parentheses

  // Convert 00 at the start to +
  if (phone.startsWith("00")) {
    phone = "+" + phone.slice(2);
  }

  // Convert 0 at the start to +[defaultCountryCode]
  if (phone.startsWith("0")) {
    phone = "+" + defaultCountryCode + phone.slice(1);
  }

  // If it doesn't start with +, return original
  if (!phone.startsWith("+")) {
    return input;
  }

  // Extract country code (1-3 digits after +)
  const match = phone.match(/^\+(\d{1,3})(\d+)/);
  if (!match) return phone;

  const countryCode = match[1];
  let rest = match[2];

  // Try to extract area code (first 1-4 digits of rest)
  let areaMatch = rest.match(/^(\d{1,4})(\d+)$/);
  if (!areaMatch) return `+${countryCode} ${rest}`;
  const areaCode = areaMatch[1];
  const subscriber = areaMatch[2];

  return `+${countryCode} ${areaCode} ${subscriber}`;
}

        if (osmResults.length > 0) {
          // Build details message and buttons
          const maxResults = 8;
          const detailsList = osmResults.slice(0, maxResults).map((item) => {
            const typeTag = getOsmTypeTag(item.tags);
            let osmTypeLine = "";
            if (item.class && item.type) {
              osmTypeLine = `*OSM type:* ${item.class} = ${item.type}\n`;
            } else if (item.tags) {
              for (const key of OSM_TYPE_KEYS) {
                if (item.tags[key]) {
                  osmTypeLine = `*OSM type:* ${key} = ${item.tags[key]}\n`;
                  break;
                }
              }
            }
            // Show all relevant OSM tags
            let tagLines = "";
            if (item.tags) {
              tagLines = OSM_TYPE_KEYS
                .filter(key => item.tags[key])
                .map(key => `*Tag:* ${key} = ${item.tags[key]}\n`)
                .join("");
            }
            // Always show Nominatim class/type if present
            let nominatimLine = "";
            if (item.class && item.type) {
              nominatimLine = `*Nominatim class/type:* ${item.class} = ${item.type}\n`;
            }
            return (
              `# ${item.osm_id}\n` +
              `*Name:* ${item.name || "(no name)"}\n` +
              osmTypeLine +
              tagLines +
              nominatimLine +
              (typeTag ? `${typeTag}\n` : "") +
              `*Address:* ${[
                item.address.street,
                item.address.housenumber,
                item.address.postcode,
                item.address.city,
                item.address.region,
                item.address.country
              ].filter(Boolean).join(", ")}\n` +
              (item.phone ? `*Phone:* ${item.phone}\n` : "") +
              (item.email ? `*Email:* ${item.email}\n` : "") +
              (item.website ? `*Website:* ${item.website}\n` : "")
            );
          }).join("\n\n");

          const keyboard = osmResults.slice(0, maxResults).map((item) => [{
            text: `# ${item.osm_id}`,
            callback_data: `osmnode:${item.id}`
          }]);
          keyboard.push([{ text: "None of the above", callback_data: "osmnode:none" }]);

          await sendMessage(
            env,
            chatId,
            `Select the correct OpenStreetMap location for this organization:\n\n${detailsList}`,
            {
              reply_markup: { inline_keyboard: keyboard },
              parse_mode: "Markdown"
            }
          );
          setStep(session, "awaiting_osm_node");
          await persistSession();
          return;
        } else {
          setStep(session, "done");
          await persistSession();
          await sendMessage(env, chatId, "Communities saved. Contact added. (No OSM location found.)");
          await removeSession();
        }
        return;
      }

      // Handle choose other countries
      if (cb === "choose_other") {
        const countries = await fetchCountries(env);
        const keyboard = countries.map(c => [{ text: c, callback_data: `country:${c}` }]);
        keyboard.push([{ text: "Back to my communities", callback_data: "back_to_my_communities" }]);
        await sendMessage(env, chatId, "Select a country:", {
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }

      // Handle back to own communities
      if (cb === "back_to_my_communities") {
        session.last_callback_data = null;
        session.last_country = null;
        await persistSession();
        // Fall through to show user's communities
      }

      // Handle country selection
      if (cb && cb.startsWith("country:")) {
        const countryCode = cb.replace("country:", "");
        session.last_country = countryCode;
        await persistSession();
        const communities = await fetchCommunitiesByCountry(env, countryCode);
        // Mark selected
        const keyboard = communities.map(comm => {
          const selected = session.selected_communities.includes(String(comm.id)) ? "✅ " : "";
          return [{ text: `${selected}${comm.name}`, callback_data: `community:${comm.id}` }];
        });
        keyboard.push([{ text: "Choose another country", callback_data: "choose_other" }]);
        keyboard.push([{ text: "Confirm selection", callback_data: "confirm_communities" }]);
        keyboard.push([{ text: "Skip", callback_data: "skip" }]);
        await sendMessage(env, chatId, "Select communities in this country (multiple possible):", {
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }

      // Handle community selection/deselection
      if (cb && cb.startsWith("community:")) {
        const communityId = String(cb.replace("community:", ""));
        const idx = session.selected_communities.indexOf(communityId);
        if (idx === -1) {
          session.selected_communities.push(communityId);
        } else {
          session.selected_communities.splice(idx, 1);
        }
        session.last_callback_data = null;
        await persistSession();
        // Re-show the same list (country or my communities)
        if (session.last_country) {
          // If last_country is set, show that country's communities
          const communities = await fetchCommunitiesByCountry(env, session.last_country);
          const keyboard = communities.map(comm => {
            const selected = session.selected_communities.includes(String(comm.id)) ? "✅ " : "";
            return [{ text: `${selected}${comm.name}`, callback_data: `community:${comm.id}` }];
          });
          keyboard.push([{ text: "Choose another country", callback_data: "choose_other" }]);
          keyboard.push([{ text: "Confirm selection", callback_data: "confirm_communities" }]);
          keyboard.push([{ text: "Skip", callback_data: "skip" }]);
          await sendMessage(env, chatId, "Select communities in this country (multiple possible):", {
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          // Show user's communities
          const userCommunities = await selectCommunitiesList(env, session.telegram_id);
          const keyboard = userCommunities.map(c => {
            const selected = session.selected_communities.includes(String(c.id)) ? "✅ " : "";
            return [{ text: `${selected}${c.name}`, callback_data: `community:${c.id}` }];
          });
          keyboard.push([{ text: "Choose other communities", callback_data: "choose_other" }]);
          keyboard.push([{ text: "Confirm selection", callback_data: "confirm_communities" }]);
          keyboard.push([{ text: "Skip", callback_data: "skip" }]);
          await sendMessage(env, chatId, "Select communities (multiple possible):", {
            reply_markup: { inline_keyboard: keyboard }
          });
        }
        return;
      }

      // Default: show user's communities
      if (!cb || cb === null) {
        const userCommunities = await selectCommunitiesList(env, session.telegram_id);
        const keyboard = userCommunities.map(c => {
          const selected = session.selected_communities.includes(String(c.id)) ? "✅ " : "";
          return [{ text: `${selected}${c.name}`, callback_data: `community:${c.id}` }];
        });
        keyboard.push([{ text: "Choose other communities", callback_data: "choose_other" }]);
        keyboard.push([{ text: "Confirm selection", callback_data: "confirm_communities" }]);
        keyboard.push([{ text: "Skip", callback_data: "skip" }]);
        await sendMessage(env, chatId, "Select communities (multiple possible):", {
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }
      break;
    }
    case "awaiting_osm_node": {
      // Handle manual node ID entry or skip after "None of the above"
      let nodeId = text && text.trim();
      if (session.last_callback_data && session.last_callback_data.startsWith("osmnode:")) {
        const cb = session.last_callback_data;
        if (cb === "osmnode:none") {
          setStep(session, "manual_osm_node");
          await persistSession();
          await sendMessage(env, chatId, "No suitable OpenStreetMap location found. Enter a node ID manually or type 'skip' to continue without one.");
          return;
        } else {
          session.osm_node_id = cb.replace("osmnode:", "");
          setStep(session, "done");
          await persistSession();

          // --- Persist organization if new, then contact ---
          let organization_id = null;
          if (session.organization && session.organization_created) {
            // Create new organization
            try {
              const orgRes = await env.crmApi.fetch(new Request(
                `${env.CRM_API_URL}/neworg`,
                {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: session.organization,
                    status: "active",
                    location_osm_id: session.osm_node_id ? session.osm_node_id : null,
                    website: session.organization_website || null,
                    created_by: session.telegram_id || null
                  })
                }
              ));
              if (orgRes.ok) {
                const orgData = await orgRes.json().catch(() => ({}));
                organization_id = orgData.id || null;
              }
            } catch (e) {}
          } else if (session.organization_id) {
            organization_id = session.organization_id;
          }

          // Persist contact with audit_log
          try {
            await env.crmApi.fetch(new Request(
              `${env.CRM_API_URL}/newcontact`,
              {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: session.name,
                  type: session.type,
                  organization_id,
                  community_id: Array.isArray(session.selected_communities) && session.selected_communities.length === 1 ? session.selected_communities[0] : null,
                  email: session.email || null,
                  phone: session.phone || null,
                  nostr_npub: session.nostr_npub || null,
                  created_by: session.telegram_id || null,
                })
              }
            ));
          } catch (e) {}

          await sendMessage(env, chatId, "OpenStreetMap node selected. Contact added.");
          await removeSession();
          return;
        }
      }
      if (nodeId && nodeId.toLowerCase() !== "skip") {
        session.osm_node_id = nodeId;
        setStep(session, "done");
        await persistSession();

        // --- Persist organization if new, then contact ---
        let organization_id = null;
        if (session.organization && session.organization_created) {
          try {
            const orgRes = await env.crmApi.fetch(new Request(
              `${env.CRM_API_URL}/neworg`,
              {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: session.organization,
                  status: "active",
                  location_osm_id: session.osm_node_id ? session.osm_node_id : null,
                  website: session.organization_website || null,
                  created_by: session.telegram_id || null
                })
              }
            ));
            if (orgRes.ok) {
              const orgData = await orgRes.json().catch(() => ({}));
              organization_id = orgData.id || null;
            }
          } catch (e) {}
        } else if (session.organization_id) {
          organization_id = session.organization_id;
        }

        try {
          await env.crmApi.fetch(new Request(
            `${env.CRM_API_URL}/newcontact`,
            {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                name: session.name,
                type: session.type,
                organization_id,
                community_id: Array.isArray(session.selected_communities) && session.selected_communities.length === 1 ? session.selected_communities[0] : null,
                email: session.email || null,
                phone: session.phone || null,
                nostr_npub: session.nostr_npub || null,
                created_by: session.telegram_id || null,
              })
            }
          ));
        } catch (e) {}

        await sendMessage(env, chatId, "Manual OpenStreetMap node ID saved. Contact added.");
        await removeSession();
        return;
      }
      if (nodeId && nodeId.toLowerCase() === "skip") {
        setStep(session, "done");
        await persistSession();

        // --- Persist organization if new, then contact ---
        let organization_id = null;
        if (session.organization && session.organization_created) {
          try {
            const orgRes = await env.crmApi.fetch(new Request(
              `${env.CRM_API_URL}/neworg`,
              {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: session.organization,
                  status: "active",
                  website: session.organization_website || null,
                  created_by: session.telegram_id || null
                })
              }
            ));
            if (orgRes.ok) {
              const orgData = await orgRes.json().catch(() => ({}));
              organization_id = orgData.id || null;
            }
          } catch (e) {}
        } else if (session.organization_id) {
          organization_id = session.organization_id;
        }

        try {
          await env.crmApi.fetch(new Request(
            `${env.CRM_API_URL}/newcontact`,
            {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                name: session.name,
                type: session.type,
                organization_id,
                community_id: Array.isArray(session.selected_communities) && session.selected_communities.length === 1 ? session.selected_communities[0] : null,
                email: session.email || null,
                phone: session.phone || null,
                nostr_npub: session.nostr_npub || null,
                created_by: session.telegram_id || null
              })
            }
          ));
        } catch (e) {}

        await sendMessage(env, chatId, "No OpenStreetMap node linked. Contact added.");
        await removeSession();
        return;
      }
      await sendMessage(env, chatId, "Please enter a node ID or type 'skip'.");
      break;
    }
    case "manual_osm_node": {
      let nodeId = text && text.trim();
      if (nodeId && nodeId.toLowerCase() !== "skip") {
        session.osm_node_id = nodeId;
        setStep(session, "done");
        await persistSession();
        await sendMessage(env, chatId, "Manual OpenStreetMap node ID saved. Contact added.");
        await removeSession();
        return;
      }
      if (nodeId && nodeId.toLowerCase() === "skip") {
        setStep(session, "done");
        await persistSession();
        await sendMessage(env, chatId, "No OpenStreetMap node linked. Contact added.");
        await removeSession();
        return;
      }
      await sendMessage(env, chatId, "Please enter a node ID or type 'skip'.");
      break;
    }
    default:
      await sendMessage(env, chatId, errorMessage("Unknown step in contact flow. Type /cancel to start over."));
      await removeSession();
      break;
  }
}
