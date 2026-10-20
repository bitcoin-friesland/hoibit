import { isValidName, isValidEmail, isValidPhone } from "../helpers/validation.js";
import { setStep } from "../helpers/session.js";
import { errorMessage, successMessage, promptWithSkip, promptWithOptions, escapeHtml } from "../helpers/messaging.js";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedCommunities
} from "../helpers/community.js";
import { findOsmNodeForOrganization } from "../helpers/osm.js";

const ORG_STATUS_CODE_TO_ID = {
  "btc-curious": 1,
  "accepts-bitcoin": 2,
  "not-interested": 3,
  "stopped-accepting": 4
};

const ORG_STATUS_OPTIONS = [
  { label: "BTC-curious", value: "btc-curious" },
  { label: "Accepts Bitcoin", value: "accepts-bitcoin" },
  { label: "Not interested", value: "not-interested" },
  { label: "Stopped accepting", value: "stopped-accepting" }
];

const ORG_PICKER_TITLE = "Select Bitcoin communities for this organization:";

const OSM_TYPE_KEYS = [
  "shop",
  "amenity",
  "office",
  "craft",
  "industrial",
  "tourism",
  "leisure",
  "healthcare",
  "religion",
  "farm",
  "landuse"
];
const OSM_MAX_RESULTS = 8;

// Words, digits and common punctuation in any script ("Café", "Bäckerei"); not a phone number or email.
function isValidOrganizationName(name) {
  return !!name && !/^\d+$/.test(name) && !/@/.test(name) && !/[^\p{L}\p{N}\s&\-,.'"]/u.test(name);
}

async function postJson(env, path, body) {
  return env.crmApi.fetch(
    new Request(`${env.CRM_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

// created_by is the team member id (team_members.id) of the user, not the Telegram user id.
function contactPayload(session, organizationId) {
  return {
    name: session.name,
    type: session.type,
    organization_id: organizationId || null,
    email: session.email || null,
    phone: session.phone || null,
    nostr_npub: session.nostr_npub || null,
    created_by: session.created_by || null
  };
}

async function addContact(sendMessage, env, chatId, session, removeSession, organizationId, doneText) {
  try {
    const res = await postJson(env, "/newcontact", contactPayload(session, organizationId));
    if (!res.ok) {
      await sendMessage(env, chatId, errorMessage(`Failed to add contact (code ${res.status}).`));
      await removeSession();
      return;
    }
  } catch (e) {
    await sendMessage(env, chatId, errorMessage(`Error adding contact: ${e && e.message ? e.message : e}`));
    await removeSession();
    return;
  }
  await sendMessage(env, chatId, successMessage(doneText));
  await removeSession();
}

async function addOrganizationAndContact(sendMessage, env, chatId, session, removeSession, osmId) {
  const statusId = ORG_STATUS_CODE_TO_ID[session.organization_status];
  if (!statusId) {
    await sendMessage(
      env,
      chatId,
      errorMessage("Organization status is missing or invalid. Please start again with /newcontact.")
    );
    await removeSession();
    return;
  }
  const communities = session.organization_communities || [];
  let orgId;
  try {
    const res = await postJson(env, "/neworg", {
      name: session.organization,
      status: statusId,
      location_osm_id: osmId || null,
      website: session.organization_website || null,
      nostr_npub: session.organization_nostr_npub || null,
      community_ids: communities.map(c => c.id),
      created_by: session.created_by || null
    });
    if (!res.ok) {
      await sendMessage(
        env,
        chatId,
        errorMessage(`Failed to add organization (code ${res.status}). Contact not added.`)
      );
      await removeSession();
      return;
    }
    orgId = (await res.json()).id;
  } catch (e) {
    await sendMessage(env, chatId, errorMessage(`Error adding organization: ${e && e.message ? e.message : e}`));
    await removeSession();
    return;
  }
  const details = [
    communities.length > 0 ? `communities: ${communities.map(c => c.name).join(", ")}` : null,
    osmId ? `OpenStreetMap: ${osmId}` : null
  ].filter(Boolean);
  await addContact(
    sendMessage,
    env,
    chatId,
    session,
    removeSession,
    orgId,
    `Organization "${session.organization}" and contact "${session.name}" added.${details.length ? ` (${details.join("; ")})` : ""}`
  );
}

function formatOsmItem(item) {
  const lines = [`<b># ${escapeHtml(item.osm_id)}</b>`, `<b>Name:</b> ${escapeHtml(item.name || "(no name)")}`];
  if (item.class && item.type) {
    lines.push(`<b>OSM type:</b> ${escapeHtml(item.class)} = ${escapeHtml(item.type)}`);
  }
  if (item.tags) {
    for (const key of OSM_TYPE_KEYS) {
      if (item.tags[key]) lines.push(`<b>Tag:</b> ${escapeHtml(key)} = ${escapeHtml(item.tags[key])}`);
    }
  }
  const address = item.address || {};
  const addressLine = [
    address.street,
    address.housenumber,
    item.postcode || address.postcode,
    address.city,
    address.region,
    address.country
  ]
    .filter(Boolean)
    .join(", ");
  if (addressLine) lines.push(`<b>Address:</b> ${escapeHtml(addressLine)}`);
  if (item.phone) lines.push(`<b>Phone:</b> ${escapeHtml(item.phone)}`);
  if (item.email) lines.push(`<b>Email:</b> ${escapeHtml(item.email)}`);
  if (item.website) lines.push(`<b>Website:</b> ${escapeHtml(item.website)}`);
  return lines.join("\n");
}

// Searches OpenStreetMap for the organization (per region of the selected communities) and either
// asks the user to pick a location or saves the organization and contact right away.
async function lookupOsmAndContinue(sendMessage, env, chatId, session, persistSession, removeSession) {
  const regions = [...new Set((session.organization_communities || []).map(c => c.region).filter(Boolean))];
  const query = {
    name: session.organization,
    phone: session.phone,
    website: session.organization_website,
    email: session.email
  };
  await sendMessage(env, chatId, "Searching for OpenStreetMap locations... ⏳");
  let osmResults = [];
  try {
    osmResults =
      regions.length > 0
        ? (await Promise.all(regions.map(region => findOsmNodeForOrganization({ ...query, region })))).flat()
        : await findOsmNodeForOrganization({ ...query, region: null });
  } catch (e) {
    osmResults = [];
  }
  osmResults = (Array.isArray(osmResults) ? osmResults : []).filter(item => item && item.id).slice(0, OSM_MAX_RESULTS);
  if (osmResults.length === 0) {
    await addOrganizationAndContact(sendMessage, env, chatId, session, removeSession, null);
    return;
  }
  session.osm_options = osmResults.map(item => String(item.id));
  setStep(session, "awaiting_osm_node");
  await persistSession();
  let details = osmResults.map(formatOsmItem).join("\n\n");
  if (details.length > 3500) details = `${details.slice(0, 3500)}\n…`;
  const keyboard = osmResults.map(item => [{ text: `# ${item.osm_id}`, callback_data: `osmnode:${item.id}` }]);
  keyboard.push([{ text: "None of the above", callback_data: "osmnode:none" }]);
  await sendMessage(env, chatId, `Select the correct OpenStreetMap location for this organization:\n\n${details}`, {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "HTML"
  });
}

export async function handleContactFlow(
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) {
  switch (session.step) {
    case "awaiting_name": {
      const name = text && text.trim();
      if (!isValidName(name)) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid contact name (minimum 3 letters, only alphabetic).")
        );
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
      session.email = email && email.toLowerCase() !== "skip" ? email : null;
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
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid phone number starting with + or 00, or tap Skip.")
        );
        return;
      }
      session.phone = phone && phone.toLowerCase() !== "skip" ? phone : null;
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
      session.nostr_npub = nostr && nostr.toLowerCase() !== "skip" ? nostr : null;
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
        await sendMessage(
          env,
          chatId,
          "Which organization is this contact linked to? (required, type part of the name to search or create a new one)"
        );
        return;
      }
      await addContact(sendMessage, env, chatId, session, removeSession, null, `Contact "${session.name}" added.`);
      break;
    }
    case "awaiting_organization": {
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      if (cb === "search_org_again") {
        await persistSession();
        await sendMessage(env, chatId, "Which organization is this contact linked to?\nType part of the name.");
        return;
      }
      if (cb && cb.startsWith("select_org:")) {
        // Existing organization: link the contact to it, nothing to create
        const orgId = cb.slice("select_org:".length);
        const orgName = session.org_choices && session.org_choices[orgId];
        if (!orgName) {
          await sendMessage(
            env,
            chatId,
            errorMessage("Please choose an organization from the buttons, or type a name to search.")
          );
          return;
        }
        await addContact(
          sendMessage,
          env,
          chatId,
          session,
          removeSession,
          Number(orgId),
          `Contact "${session.name}" added to "${orgName}".`
        );
        return;
      }
      if (cb === "create_org") {
        if (!session.pending_org) {
          await sendMessage(env, chatId, errorMessage("Please type the name of the organization."));
          return;
        }
        session.organization = session.pending_org;
        setStep(session, "awaiting_org_status");
        await persistSession();
        const prompt = promptWithOptions(
          "What is the Bitcoin adoption status of the organization?",
          ORG_STATUS_OPTIONS
        );
        await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
        return;
      }
      const org = text && text.trim();
      if (!isValidOrganizationName(org)) {
        await sendMessage(
          env,
          chatId,
          errorMessage(
            "Please enter a valid organization name (organization names should be words, not a phone number or symbols)."
          )
        );
        return;
      }
      try {
        const searchRes = await env.crmApi.fetch(
          new Request(`${env.CRM_API_URL}/organizations/search?name=${encodeURIComponent(org)}`, { method: "GET" })
        );
        if (!searchRes.ok) {
          await sendMessage(env, chatId, errorMessage(`Error searching organizations (code ${searchRes.status})`));
          return;
        }
        const data = await searchRes.json();
        const orgs = (Array.isArray(data) ? data : data.orgs || []).slice(0, 5);
        // Names stay in the session; buttons carry only ids (callback_data is limited to 64 bytes).
        session.pending_org = org;
        session.org_choices = Object.fromEntries(orgs.map(o => [String(o.id), o.name]));
        await persistSession();
        if (orgs.length > 0) {
          const keyboard = orgs.map(o => [{ text: o.name, callback_data: `select_org:${o.id}` }]);
          keyboard.push([{ text: `Create new "${org}"`, callback_data: "create_org" }]);
          await sendMessage(env, chatId, "Select an existing organization or create new:", {
            reply_markup: { inline_keyboard: keyboard }
          });
        } else {
          await sendMessage(env, chatId, `No organization found with the name "${org}".`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: `Confirm and create "${org}"`, callback_data: "create_org" }],
                [{ text: "Search again", callback_data: "search_org_again" }]
              ]
            }
          });
        }
      } catch (e) {
        await sendMessage(env, chatId, errorMessage(`Exception during org search: ${e && e.message ? e.message : e}`));
      }
      break;
    }
    case "awaiting_org_status": {
      let status = text;
      if (!status && session.last_callback_data) {
        status = session.last_callback_data;
      }
      if (!status || !ORG_STATUS_CODE_TO_ID[status]) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please select a valid Bitcoin adoption status for the organization.")
        );
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
      session.organization_nostr_npub = nostr && nostr.toLowerCase() !== "skip" ? nostr : null;
      session.org_picker = await startCommunityPicker(env, session.telegram_id);
      setStep(session, "awaiting_communities");
      await persistSession();
      await sendMessage(env, chatId, ...renderCommunityPicker(session.org_picker, ORG_PICKER_TITLE));
      break;
    }
    case "awaiting_communities": {
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, session.org_picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(env, chatId, ...renderCommunityPicker(session.org_picker, ORG_PICKER_TITLE));
      } else if (result === "done" || result === "skip") {
        session.organization_communities = result === "skip" ? [] : pickedCommunities(session.org_picker);
        await persistSession();
        await lookupOsmAndContinue(sendMessage, env, chatId, session, persistSession, removeSession);
      } else if (result.error) {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please use the buttons to select communities, then press Done or Skip.")
        );
      }
      break;
    }
    case "awaiting_osm_node": {
      const cb = session.last_callback_data;
      const choice = cb && cb.startsWith("osmnode:") ? cb.slice("osmnode:".length) : null;
      if (!choice || (choice !== "none" && !(session.osm_options || []).includes(choice))) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please select a valid OpenStreetMap location or 'None of the above'.")
        );
        return;
      }
      await addOrganizationAndContact(
        sendMessage,
        env,
        chatId,
        session,
        removeSession,
        choice === "none" ? null : choice
      );
      break;
    }
  }
}
