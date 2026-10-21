/**
 * The steps that describe a new organization, shared by /newcontact (an entrepreneur with a new
 * organization, session.mode "contact") and /neworg (session.mode "org"): status, website, npub,
 * communities and OpenStreetMap location, then saving. Each flow asks for the name itself and
 * calls startOrganizationSteps; from then on it hands its updates to handleOrganizationStep.
 */
import { isValidNpub, isValidWebsite } from "../helpers/validation";
import { setStep } from "../helpers/session";
import { errorMessage, successMessage, promptWithSkip, promptWithOptions, escapeHtml } from "../helpers/messaging";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedCommunities
} from "../helpers/community";
import { findOsmNodeForOrganization, type OsmResult } from "../helpers/osm";
import type { ChatId, SendMessage, Session } from "../types";

const ORG_STATUS_CODE_TO_ID: Record<string, number> = {
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

const OSM_TYPE_KEYS = "shop amenity office craft industrial tourism leisure healthcare religion farm landuse".split(
  " "
);
const OSM_MAX_RESULTS = 8;
// Room for the OpenStreetMap details within Telegram's 4096-character message limit.
const OSM_DETAILS_MAX_LENGTH = 3500;

// Organizations listed after a name search.
export const ORG_MAX_RESULTS = 5;

export const INVALID_ORGANIZATION_NAME =
  "Please enter a valid organization name (organization names should be words, not a phone number or symbols).";

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The command that starts the user's flow again.
const restartCommand = (session: Session) => (session.mode === "org" ? "/neworg" : "/newcontact");

// The contact of a /newcontact session, as newContact takes it. created_by is the team member
// id (team_members.id) of the user, not the Telegram user id.
export function contactInput(session: Session) {
  return {
    name: session.name ?? "",
    type: session.type ?? "",
    email: session.email || null,
    phone: session.phone || null,
    nostr_npub: session.nostr_npub || null,
    created_by: session.created_by || null
  };
}

/**
 * Starts the organization steps for a new organization called name: asks for its status.
 */
export async function startOrganizationSteps(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  name: string
) {
  session.organization = name;
  setStep(session, "awaiting_org_status");
  await persistSession();
  const prompt = promptWithOptions("What is the Bitcoin adoption status of the organization?", ORG_STATUS_OPTIONS);
  await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
}

/**
 * Saves the new organization. For /newcontact the organization, its communities, the contact
 * and their audit entries go in one newContact call, so a failure leaves nothing behind.
 */
async function saveOrganization(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  removeSession: () => Promise<void>,
  osmId: string | null
) {
  const status = session.organization_status && ORG_STATUS_CODE_TO_ID[session.organization_status];
  if (!status) {
    await sendMessage(
      env,
      chatId,
      errorMessage(`Organization status is missing or invalid. Please start again with ${restartCommand(session)}.`)
    );
    await removeSession();
    return;
  }
  const communities = session.organization_communities || [];
  const organization = {
    name: session.organization ?? "",
    status,
    location_osm_id: osmId,
    website: session.organization_website || null,
    nostr_npub: session.organization_nostr_npub || null,
    community_ids: communities.map(c => c.id)
  };
  const details = [
    communities.length > 0 ? `communities: ${communities.map(c => c.name).join(", ")}` : null,
    osmId ? `OpenStreetMap: ${osmId}` : null
  ].filter(Boolean);
  const suffix = details.length ? ` (${details.join("; ")})` : "";
  if (session.mode === "contact") {
    try {
      const res = await env.crmApi.newContact({ ...contactInput(session), new_organization: organization });
      await sendMessage(
        env,
        chatId,
        res.ok
          ? successMessage(`Organization "${session.organization}" and contact "${session.name}" added.${suffix}`)
          : errorMessage(`Failed to add organization and contact (code ${res.status}). Nothing was saved.`)
      );
    } catch (e) {
      await sendMessage(
        env,
        chatId,
        errorMessage(`Error adding organization and contact (${errorText(e)}). Nothing was saved.`)
      );
    }
  } else {
    try {
      const res = await env.crmApi.newOrg({ ...organization, created_by: session.created_by || null });
      await sendMessage(
        env,
        chatId,
        res.ok
          ? successMessage(`Organization "${session.organization}" added.${suffix}`)
          : errorMessage(`Failed to add organization (code ${res.status}).`)
      );
    } catch (e) {
      await sendMessage(env, chatId, errorMessage(`Error adding organization: ${errorText(e)}`));
    }
  }
  await removeSession();
}

function formatOsmItem(item: OsmResult) {
  const lines = [`<b># ${escapeHtml(item.osm_id)}</b>`, `<b>Name:</b> ${escapeHtml(item.name || "(no name)")}`];
  if (item.class && item.type) {
    lines.push(`<b>OSM type:</b> ${escapeHtml(item.class)} = ${escapeHtml(item.type)}`);
  }
  if (item.tags) {
    for (const key of OSM_TYPE_KEYS) {
      if (item.tags[key]) lines.push(`<b>Tag:</b> ${escapeHtml(key)} = ${escapeHtml(item.tags[key])}`);
    }
  }
  const address = item.address;
  const addressLine = [
    address.street,
    address.housenumber,
    address.postcode,
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
// asks the user to pick a location or saves right away.
async function lookupOsmAndContinue(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  removeSession: () => Promise<void>
) {
  const regions = (session.organization_communities || []).map(c => c.region).filter((r): r is string => !!r);
  await sendMessage(env, chatId, "Searching for OpenStreetMap locations... ⏳");
  let osmResults: OsmResult[] = [];
  try {
    // One lookup for all regions: it deduplicates the results and spaces the Nominatim requests.
    osmResults = await findOsmNodeForOrganization({
      name: session.organization ?? "",
      regions,
      phone: session.phone,
      website: session.organization_website,
      email: session.email
    });
  } catch {
    osmResults = [];
  }
  osmResults = osmResults.filter(item => item && item.id).slice(0, OSM_MAX_RESULTS);
  if (osmResults.length === 0) {
    await saveOrganization(sendMessage, env, chatId, session, removeSession, null);
    return;
  }
  // Whole items only: a cut inside an HTML tag makes Telegram refuse the entire message.
  const items: string[] = [];
  let length = 0;
  for (const item of osmResults) {
    const formatted = formatOsmItem(item);
    const added = (items.length > 0 ? 2 : 0) + formatted.length;
    if (items.length > 0 && length + added > OSM_DETAILS_MAX_LENGTH) break;
    items.push(formatted);
    length += added;
  }
  const more = items.length < osmResults.length ? `\n\nShowing ${items.length} of ${osmResults.length} locations.` : "";
  osmResults = osmResults.slice(0, items.length);
  session.osm_options = osmResults.map(item => String(item.id));
  setStep(session, "awaiting_osm_node");
  await persistSession();
  const details = items.join("\n\n") + more;
  const keyboard = osmResults.map(item => [{ text: `# ${item.osm_id}`, callback_data: `osmnode:${item.id}` }]);
  keyboard.push([{ text: "None of the above", callback_data: "osmnode:none" }]);
  await sendMessage(env, chatId, `Select the correct OpenStreetMap location for this organization:\n\n${details}`, {
    reply_markup: { inline_keyboard: keyboard },
    parse_mode: "HTML"
  });
}

/**
 * Handles the update when session.step is one of the organization steps; returns false (and
 * does nothing) for any other step.
 */
export async function handleOrganizationStep(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  text: string | undefined,
  session: Session,
  persistSession: () => Promise<void>,
  removeSession: () => Promise<void>
): Promise<boolean> {
  switch (session.step) {
    case "awaiting_org_status": {
      const status = text || session.last_callback_data;
      if (!status || !ORG_STATUS_CODE_TO_ID[status]) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please select a valid Bitcoin adoption status for the organization.")
        );
        return true;
      }
      session.organization_status = status;
      setStep(session, "awaiting_org_website");
      await persistSession();
      const prompt = promptWithSkip("What is the website of the organization? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      return true;
    }
    case "awaiting_org_website": {
      let website = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip" || website?.toLowerCase() === "skip") {
        website = undefined;
      } else if (website && !isValidWebsite(website)) {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please enter a valid website (for example example.com) or tap Skip.")
        );
        return true;
      }
      session.organization_website = website || null;
      setStep(session, "awaiting_org_nostr");
      await persistSession();
      const prompt = promptWithSkip("What is the nostr npub of the organization? (optional)");
      await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
      return true;
    }
    case "awaiting_org_nostr": {
      let nostr = text && text.trim();
      if (text === undefined || session.last_callback_data === "skip" || nostr?.toLowerCase() === "skip") {
        nostr = undefined;
      } else if (nostr && !isValidNpub(nostr)) {
        await sendMessage(env, chatId, errorMessage("Please enter a valid nostr npub (npub1…) or tap Skip."));
        return true;
      }
      session.organization_nostr_npub = nostr || null;
      session.org_picker = await startCommunityPicker(env, session.telegram_id);
      setStep(session, "awaiting_communities");
      await persistSession();
      await sendMessage(env, chatId, ...renderCommunityPicker(session.org_picker, ORG_PICKER_TITLE));
      return true;
    }
    case "awaiting_communities": {
      const picker = session.org_picker;
      if (!picker) {
        await sendMessage(
          env,
          chatId,
          errorMessage(`Session expired. Please start again with ${restartCommand(session)}.`)
        );
        await removeSession();
        return true;
      }
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(env, chatId, ...renderCommunityPicker(picker, ORG_PICKER_TITLE));
      } else if (result === "done" || result === "skip") {
        session.organization_communities = result === "skip" ? [] : pickedCommunities(picker);
        await persistSession();
        await lookupOsmAndContinue(sendMessage, env, chatId, session, persistSession, removeSession);
      } else if (typeof result === "object") {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(
          env,
          chatId,
          errorMessage("Please use the buttons to select communities, then press Done or Skip.")
        );
      }
      return true;
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
        return true;
      }
      await saveOrganization(sendMessage, env, chatId, session, removeSession, choice === "none" ? null : choice);
      return true;
    }
    default:
      return false;
  }
}
