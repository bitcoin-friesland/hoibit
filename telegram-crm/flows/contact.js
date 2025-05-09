import { isValidName, isValidEmail, isValidPhone } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, promptWithSkip, promptWithOptions } from "../helpers/messaging.js";
import { selectCommunities, fetchCountries, fetchCommunitiesByCountry, selectCommunitiesList } from "../helpers/community.js";
import { findOsmNodeForOrganization } from "../helpers/osm.js";

// Formats a phone number to international format (dummy implementation)
function formatPhoneNumber(phone) {
  // Add real formatting logic as needed
  return phone;
}

// Ensures item.class and item.type are set for Overpass results (dummy implementation)
function setOsmClassAndTypeFromTags(osmResults) {
  // Add real logic as needed
  return;
}

/**
 * Returns a formatted OSM type tag string for given tags, or null if not found.
 */
const ORG_STATUS_CODE_TO_ID = {
  "btc-curious": 1,
  "accepts-bitcoin": 2,
  "not-interested": 3,
  "stopped-accepting": 4
};

export async function handleContactFlow(sendMessage, env, chatId, text, session, persistSession = async () => { }, removeSession = async () => { }) {
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
          const response = await env.crmApi.fetch(new Request(
            `${env.CRM_API_URL}/newcontact`,
            {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                name: session.name,
                type: session.type,
                organization_id: session.organization_id || null,
                email: session.email || null,
                phone: session.phone || null,
                nostr_npub: session.nostr_npub || null,
                created_by: session.telegram_id || null,
              })
            }
          ));
          if (!response.ok) {
            await sendMessage(env, chatId, `Failed to add contact (consumer flow): ${response.statusText || response.status}`);
            return;
          }
        } catch (e) {
          await sendMessage(env, chatId, `Error adding contact (consumer flow): ${e.message || e}`);
          return;
        }
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
            session.last_callback_data.startsWith("confirm_org:") ? session.last_callback_data.replace("confirm_org:", "")
              : session.last_callback_data.startsWith("select_org:") ? session.last_callback_data.replace("select_org:", "")
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
        setStep(session, "awaiting_org_status");
        await persistSession();
        const statusOptions = [
          { label: "BTC-curious", value: "btc-curious" },
          { label: "Accepts Bitcoin", value: "accepts-bitcoin" },
          { label: "Not interested", value: "not-interested" },
          { label: "Stopped accepting", value: "stopped-accepting" }
        ];
        const prompt = promptWithOptions("What is the Bitcoin adoption status of the organization?", statusOptions);
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
    case "awaiting_org_status": {
      let status = text;
      if (!status && session.last_callback_data) {
        status = session.last_callback_data;
      }
      const validStatuses = [
        "btc-curious",
        "accepts-bitcoin",
        "not-interested",
        "stopped-accepting"
      ];
      if (!status || !validStatuses.includes(status)) {
        await sendMessage(env, chatId, errorMessage("Please select a valid Bitcoin adoption status for the organization."));
        return;
      }
      session.organization_status = status;
      setStep(session, "awaiting_org_website");
      await persistSession();
      const prompt = promptWithSkip("What is the website of the organization? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_org_website": {
      let website = text && text.trim();
      if (session.last_callback_data === "skip") {
        website = null;
      }
      session.organization_website = website || null;

      setStep(session, "awaiting_org_nostr");
      await persistSession();
      const prompt = promptWithSkip("What is the nostr npub of the organization? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      break;
    }
    case "awaiting_org_nostr": {
      let nostr = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip") {
        nostr = null;
      }
      session.organization_nostr_npub = (nostr && nostr.toLowerCase() !== "skip") ? nostr : null;
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

          // Format phone number to international format
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
              return `# ${item.osm_id}
*Name:* ${item.name || "(no name)"}
${osmTypeLine}${tagLines}${nominatimLine}${typeTag ? `${typeTag}\n` : ""}*Address:* ${[
                  item.address.street,
                  item.address.housenumber,
                  item.postcode,
                  item.address.city,
                  item.address.region,
                  item.address.country
                ].filter(Boolean).join(", ")}
${item.phone ? `*Phone:* ${item.phone}\n` : ""}${item.email ? `*Email:* ${item.email}\n` : ""}${item.website ? `*Website:* ${item.website}\n` : ""}`;
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
            setStep(session, "awaiting_org_nostr");
            await persistSession();
            await sendMessage(env, chatId, "Communities saved. Please enter the nostr npub of the organization (optional).");
          }
        } // <-- Close onComplete async function
      }); // <-- Close selectCommunities call
      break;
    }
    case "awaiting_communities": {
      // Multi-select communities
      if (!session.selected_communities) session.selected_communities = [];

      const cb = session.last_callback_data;

      // Handle community selection (toggle)
      if (cb && cb.startsWith("community:")) {
        const commId = cb.split(":")[1];
        if (!session.selected_communities) session.selected_communities = [];
        const commIdStr = String(commId);
        const idx = session.selected_communities.indexOf(commIdStr);
        if (idx === -1) {
          session.selected_communities.push(commIdStr);
        } else {
          session.selected_communities.splice(idx, 1);
        }
        await persistSession();

        // Fetch all communities for button labels
        const allComms = await selectCommunitiesList(env, session.telegram_id);
        const keyboard = allComms.map(c => {
          const selected = session.selected_communities.includes(String(c.id));
          return [{
            text: `${selected ? "✅ " : ""}${c.name}`,
            callback_data: `community:${c.id}`
          }];
        });
        keyboard.push(
          [{ text: "Confirm", callback_data: "confirm_communities" }],
          [{ text: "Skip", callback_data: "skip" }]
        );
        await sendMessage(env, chatId, "Select Bitcoin communities for this organization (multiple allowed):", {
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }

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

        // Format phone number to international format
        if (phone) {
          phone = formatPhoneNumber(phone);
        }

        // Show loader before OSM lookup
        await sendMessage(env, chatId, "Searching for OpenStreetMap locations... ⏳");

        let osmResults = [];
        try {
          if (regions.length > 0) {
            // Search per region, aggregate results
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
          } else {
            // No regions, do a single search without region
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
            return `# ${item.osm_id}
*Name:* ${item.name || "(no name)"}
${osmTypeLine}${tagLines}${nominatimLine}${typeTag ? `${typeTag}\n` : ""}*Address:* ${[
                item.address.street,
                item.address.housenumber,
                item.postcode,
                item.address.city,
                item.address.region,
                item.address.country
              ].filter(Boolean).join(", ")}
${item.phone ? `*Phone:* ${item.phone}\n` : ""}${item.email ? `*Email:* ${item.email}\n` : ""}${item.website ? `*Website:* ${item.website}\n` : ""}`;
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
          // No OSM results, but still need to create org and contact
          try {
            // 1. Create organization (without OSM node)
            // Robustness: Ensure organization_status is set and valid before creating org
            const validStatuses = [
              "btc-curious",
              "accepts-bitcoin",
              "not-interested",
              "stopped-accepting"
            ];
            if (!session.organization_status || !validStatuses.includes(session.organization_status)) {
              await sendMessage(env, chatId, "Error: Organization status is missing or invalid. Please restart the flow.");
              return;
            }
            const statusId = ORG_STATUS_CODE_TO_ID[session.organization_status];
            if (!statusId) {
              await sendMessage(env, chatId, "Error: Could not map organization status to ID. Please contact support.");
              return;
            }
            const orgPayload = {
              name: session.organization,
              website: session.organization_website || null,
              nostr_npub: session.organization_nostr_npub || null,
              location_osm_id: null,
              status: ORG_STATUS_CODE_TO_ID[session.organization_status],
              created_by: session.telegram_id || null
            };
            const orgResponse = await env.crmApi.fetch(new Request(
              `${env.CRM_API_URL}/neworg`,
              {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(orgPayload)
              }
            ));
            if (!orgResponse.ok) {
              await sendMessage(env, chatId, `Failed to add organization: ${orgResponse.statusText || orgResponse.status}`);
              return;
            }
            // 2. Get organization id (search by name)
            let orgId = null;
            try {
              const searchUrl = `${env.CRM_API_URL}/organizations/search?name=${encodeURIComponent(session.organization)}`;
              const searchRes = await env.crmApi.fetch(new Request(
                searchUrl,
                { method: "GET", headers: { "Authorization": `Bearer ${env.API_TOKEN}` } }
              ));
              if (searchRes.ok) {
                const orgs = await searchRes.json();
                if (Array.isArray(orgs)) {
                  orgId = orgs.find(o =>
                    o.name === session.organization
                  )?.id;
                }
              }
            } catch (e) {
              // fallback: orgId remains null
            }
            if (!orgId) {
              await sendMessage(env, chatId, "Organization created, but could not retrieve organization ID. Contact not added.");
              return;
            }
            // 3. Add contact with organization_id
            const contactPayload = {
              name: session.name,
              type: session.type,
              organization_id: orgId,
              email: session.email || null,
              phone: session.phone || null,
              nostr_npub: session.nostr_npub || null,
              created_by: session.telegram_id || null
            };
            const contactResponse = await env.crmApi.fetch(new Request(
              `${env.CRM_API_URL}/newcontact`,
              {
                method: "POST",
                headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(contactPayload)
              }
            ));
            if (!contactResponse.ok) {
              await sendMessage(env, chatId, `Failed to add contact: ${contactResponse.statusText || contactResponse.status}`);
              return;
            }
          } catch (e) {
            await sendMessage(env, chatId, `Error adding contact or organization: ${e.message || e}`);
            return;
          }
          setStep(session, "done");
          await persistSession();
          await sendMessage(env, chatId, "Communities saved. Organization and contact added. (No OSM location found.)");
          await removeSession();
        }
        break;
      }
    }
      // End of awaiting_communities case
      break;
    case "awaiting_osm_node": {
      const cb = session.last_callback_data;
      if (!cb || (!cb.startsWith("osmnode:"))) {
        await sendMessage(env, chatId, errorMessage("Please select a valid OpenStreetMap location or 'None of the above'."));
        return;
      }
      let selectedOsmId = cb.split(":")[1];
      if (selectedOsmId === "none") {
        session.osm_node = null;
      } else {
        session.osm_node = selectedOsmId;
      }

      // Add organization first, then contact (entrepreneur flow)
      try {
        // 1. Create organization
        // Robustness: Ensure organization_status is set and valid before creating org
        const validStatuses = [
          "btc-curious",
          "accepts-bitcoin",
          "not-interested",
          "stopped-accepting"
        ];
        if (!session.organization_status || !validStatuses.includes(session.organization_status)) {
          await sendMessage(env, chatId, "Error: Organization status is missing or invalid. Please restart the flow.");
          return;
        }
        const statusId = ORG_STATUS_CODE_TO_ID[session.organization_status];
        if (!statusId) {
          await sendMessage(env, chatId, "Error: Could not map organization status to ID. Please contact support.");
          return;
        }
        const orgPayload = {
          name: session.organization,
          website: session.organization_website || null,
          nostr_npub: session.organization_nostr_npub || null,
          location_osm_id: session.osm_node || null,
          status: ORG_STATUS_CODE_TO_ID[session.organization_status],
          created_by: session.telegram_id || null
        };
        const orgResponse = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/neworg`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(orgPayload)
          }
        ));
        if (!orgResponse.ok) {
          await sendMessage(env, chatId, `Failed to add organization: ${orgResponse.statusText || orgResponse.status}`);
          return;
        }
        // 2. Get organization id (search by name, website, and OSM id)
        let orgId = null;
        try {
          const searchUrl = `${env.CRM_API_URL}/organizations/search?name=${encodeURIComponent(session.organization)}`;
          const searchRes = await env.crmApi.fetch(new Request(
            searchUrl,
            { method: "GET", headers: { "Authorization": `Bearer ${env.API_TOKEN}` } }
          ));
          if (searchRes.ok) {
            const orgs = await searchRes.json();
            // Try to find the org with matching name and OSM id (if available)
            if (Array.isArray(orgs)) {
              orgId = orgs.find(o =>
                o.name === session.organization &&
                (session.osm_node ? String(o.location_osm_id) === String(session.osm_node) : true)
              )?.id;
            }
          }
        } catch (e) {
          // fallback: orgId remains null
        }
        if (!orgId) {
          await sendMessage(env, chatId, "Organization created, but could not retrieve organization ID. Contact not added.");
          return;
        }
        // 3. Add contact with organization_id
        const contactPayload = {
          name: session.name,
          type: session.type,
          organization_id: orgId,
          email: session.email || null,
          phone: session.phone || null,
          nostr_npub: session.nostr_npub || null,
          created_by: session.telegram_id || null
        };
        const contactResponse = await env.crmApi.fetch(new Request(
          `${env.CRM_API_URL}/newcontact`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(contactPayload)
          }
        ));
        if (!contactResponse.ok) {
          await sendMessage(env, chatId, `Failed to add contact: ${contactResponse.statusText || contactResponse.status}`);
          return;
        }
      } catch (e) {
        await sendMessage(env, chatId, `Error adding contact or organization: ${e.message || e}`);
        return;
      }
      await sendMessage(env, chatId, "OpenStreetMap node selected. Organization and contact added.");
      setStep(session, "done");
      await persistSession();
      await removeSession();
      break;
    }
  } // <-- Add this to close the switch statement
  // End of switch
}
// End of handleContactFlow
