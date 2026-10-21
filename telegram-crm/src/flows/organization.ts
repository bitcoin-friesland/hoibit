/**
 * The steps after the name of a new contact or organization, shared by /newcontact (session.mode
 * "contact") and /neworg (session.mode "org"): the status and communities of a new organization,
 * the overview card with the optional details (helpers/card.ts), the OpenStreetMap location of a
 * new organization, and saving. Each flow asks for the name itself, then calls
 * startOrganizationSteps or showRecordCard; from then on it hands its updates to
 * handleOrganizationStep.
 */
import { setStep } from "../helpers/session";
import { errorMessage, successMessage, promptWithOptions, escapeHtml } from "../helpers/messaging";
import { handleCardStep, showCard, type CardHeader } from "../helpers/card";
import {
  startCommunityPicker,
  renderCommunityPicker,
  handleCommunityPickerInput,
  pickedAnswer,
  pickedCommunities
} from "../helpers/community";
import { findOsmNodeForOrganization, type OsmResult } from "../helpers/osm";
import { callTelegram } from "../helpers/telegram";
import type { ChatId, InlineKeyboardButton, SendMessage, SendOptions, Session } from "../types";

// The statuses as organization_statuses has them; the codes are the buttons' callback_data.
const ORG_STATUSES: Record<string, { id: number; label: string }> = {
  "btc-curious": { id: 1, label: "Curious about Bitcoin" },
  "accepts-bitcoin": { id: 2, label: "Accepts Bitcoin" },
  "not-interested": { id: 3, label: "Not Interested" },
  "stopped-accepting": { id: 4, label: "Stopped Accepting Bitcoin" }
};

const ORG_PICKER_TITLE = "Select Bitcoin communities for this organization:";

const OSM_TYPE_KEYS = "shop amenity office craft industrial tourism leisure healthcare religion farm landuse".split(
  " "
);
const OSM_MAX_RESULTS = 8;
// Longer place names are cut, so eight of them fit in one message and on buttons.
const OSM_NAME_MAX_LENGTH = 60;
const SAVE_FAILED = "Saving failed, nothing was saved. Please try again.";

// Organizations listed after a name search.
export const ORG_MAX_RESULTS = 5;

// A button under a new contact that starts logging a conversation with them (log:<id>).
export const logConversationButton = (contactId: number, name: string): SendOptions => ({
  reply_markup: { inline_keyboard: [[{ text: `💬 Log conversation with ${name}`, callback_data: `log:${contactId}` }]] }
});

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

const communityNames = (session: Session) => (session.organization_communities ?? []).map(c => c.name).join(", ");
const statusLabel = (session: Session) => ORG_STATUSES[session.organization_status ?? ""]?.label ?? "";

// What the card says about the contact and organization, above the optional details.
const cardHeader: CardHeader = session => {
  if (session.mode === "org") {
    return [
      "New organization:",
      `🏢 ${session.organization}`,
      `🏷️ ${statusLabel(session)}`,
      `👥 ${communityNames(session) || "No community"}`
    ];
  }
  const lines = [
    "New contact:",
    `👤 ${session.name}`,
    `🏷️ ${session.type === "entrepreneur" ? "Entrepreneur" : "Consumer"}`
  ];
  if (session.organization) {
    lines.push(
      `🏢 ${session.organization} (new: ${statusLabel(session)}; ${communityNames(session) || "no community"})`
    );
  } else if (session.organization_label) {
    lines.push(`🏢 ${session.organization_label}`);
  }
  return lines;
};

// Shows the overview card of the contact or organization in the session.
export async function showRecordCard(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>
) {
  await showCard(sendMessage, env, chatId, session, persistSession, cardHeader);
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
  const options = Object.entries(ORG_STATUSES).map(([value, { label }]) => ({ label, value }));
  const prompt = promptWithOptions(`What is the Bitcoin status of "${name}"?`, options);
  await sendMessage(env, chatId, prompt.text, { reply_markup: prompt.reply_markup });
}

/**
 * Saves what the card describes. The contact and a new organization with its communities go in
 * one newContact call, so a failure leaves nothing behind. On a failure the session stays, so the
 * user can try again with the same input.
 */
async function save(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  removeSession: () => Promise<void>,
  osmId: string | null,
  osmNotFound = false
) {
  const communities = session.organization_communities || [];
  const organization = session.organization
    ? {
        name: session.organization,
        status: ORG_STATUSES[session.organization_status ?? ""]?.id ?? 0,
        location_osm_id: osmId,
        website: session.organization_website || null,
        nostr_npub: session.organization_nostr_npub || null,
        community_ids: communities.map(c => c.id)
      }
    : undefined;
  const details = [
    communities.length > 0 ? `communities: ${communities.map(c => c.name).join(", ")}` : null,
    osmId ? "📍 location linked" : null
  ].filter(Boolean);
  const suffix =
    (details.length ? ` (${details.join("; ")})` : "") + (osmNotFound ? "\nNo OpenStreetMap location was found." : "");
  try {
    if (session.mode === "org") {
      const res = await env.crmApi.newOrg({ ...organization!, created_by: session.created_by || null });
      if (!res.ok) throw new Error(res.error);
      await sendMessage(env, chatId, successMessage(`Organization "${session.organization}" added.${suffix}`));
    } else {
      const res = await env.crmApi.newContact({
        ...contactInput(session),
        ...(organization ? { new_organization: organization } : { organization_id: session.organization_id ?? null })
      });
      if (!res.ok) throw new Error(res.error);
      const done = organization
        ? `Organization "${session.organization}" and contact "${session.name}" added.${suffix}`
        : session.organization_label
          ? `Contact "${session.name}" added to "${session.organization_label}".`
          : `Contact "${session.name}" added.`;
      await sendMessage(env, chatId, successMessage(done), logConversationButton(res.id, session.name ?? ""));
    }
  } catch (e) {
    console.error("Saving a contact or organization failed", e);
    await sendMessage(env, chatId, errorMessage(SAVE_FAILED));
    return;
  }
  await removeSession();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const osmName = (item: OsmResult) => clip(item.name || "(no name)", OSM_NAME_MAX_LENGTH);

// "Nieuwestad 1, Leeuwarden"
const osmPlace = (item: OsmResult) =>
  [[item.address.street, item.address.housenumber].filter(Boolean).join(" "), item.address.city]
    .filter(Boolean)
    .join(", ");

// What kind of place it is in plain words, e.g. "cafe", or "bicycle shop" for shop=bicycle.
function osmKind(item: OsmResult) {
  // Overpass gives the tags; Nominatim also says it as class and type (amenity, cafe).
  const key = OSM_TYPE_KEYS.find(k => item.tags?.[k]) ?? (OSM_TYPE_KEYS.includes(item.class) ? item.class : undefined);
  const value = key && (item.tags?.[key] || item.type);
  if (!key || !value) return "";
  const words = value.replaceAll("_", " ");
  return key === "shop" && words !== "yes" ? `${words} shop` : words;
}

function osmItem(item: OsmResult, number: number) {
  const about = [osmKind(item), osmPlace(item)].filter(Boolean).join(" · ");
  return [
    `<b>${number}. ${escapeHtml(osmName(item))}</b>`,
    ...(about ? [escapeHtml(about)] : []),
    `<a href="https://www.openstreetmap.org/${escapeHtml(item.id)}">View on the map</a>`
  ].join("\n");
}

const OSM_MORE_BUTTONS: InlineKeyboardButton[][] = [
  [{ text: "🔍 Search another name", callback_data: "osm:search" }],
  [{ text: "None of these", callback_data: "osmnode:none" }]
];

/**
 * Searches OpenStreetMap for the new organization (per region of its communities) and asks which
 * place it is. When the first search finds nothing, it saves right away without a location.
 */
async function lookupOsmAndContinue(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>,
  removeSession: () => Promise<void>
) {
  const regions = (session.organization_communities || []).map(c => c.region).filter((r): r is string => !!r);
  const name = session.osm_name || session.organization || "";
  // The search takes a few seconds; Telegram shows "typing…" meanwhile.
  await callTelegram(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  let results: OsmResult[] = [];
  try {
    // One lookup for all regions: it deduplicates the results and spaces the Nominatim requests.
    results = await findOsmNodeForOrganization({
      name,
      regions,
      phone: session.phone,
      website: session.organization_website,
      email: session.email
    });
  } catch {
    results = [];
  }
  results = results.filter(item => item && item.id).slice(0, OSM_MAX_RESULTS);
  if (results.length === 0 && !session.osm_name) {
    await save(sendMessage, env, chatId, session, removeSession, null, true);
    return;
  }
  session.osm_options = results.map(item => item.id);
  setStep(session, "awaiting_osm_node");
  await persistSession();
  if (results.length === 0) {
    await sendMessage(env, chatId, `Nothing found on OpenStreetMap for "${name}".`, {
      reply_markup: { inline_keyboard: OSM_MORE_BUTTONS }
    });
    return;
  }
  const keyboard = results.map((item, i) => {
    const place = osmPlace(item);
    const text = clip(`${i + 1}. ${osmName(item)}${place ? ` – ${place}` : ""}`, 64);
    return [{ text, callback_data: `osmnode:${item.id}` }];
  });
  const items = results.map((item, i) => osmItem(item, i + 1)).join("\n\n");
  await sendMessage(env, chatId, `Which place on OpenStreetMap is "${escapeHtml(name)}"?\n\n${items}`, {
    reply_markup: { inline_keyboard: [...keyboard, ...OSM_MORE_BUTTONS] },
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  });
}

/**
 * Handles the update when session.step is one of the shared steps; returns false (and does
 * nothing) for any other step.
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
      if (!status || !ORG_STATUSES[status]) {
        await sendMessage(env, chatId, errorMessage("Please choose the Bitcoin status from the buttons."));
        return true;
      }
      session.organization_status = status;
      // The member's own communities start selected: usually the organization is in one of them.
      session.org_picker = await startCommunityPicker(env, session.telegram_id, [], { selectOwn: true });
      setStep(session, "awaiting_communities");
      await persistSession();
      await sendMessage(
        env,
        chatId,
        ...renderCommunityPicker(session.org_picker, ORG_PICKER_TITLE, { skipLabel: "No community" })
      );
      return true;
    }
    case "awaiting_communities": {
      const picker = session.org_picker;
      if (!picker) {
        await sendMessage(env, chatId, errorMessage("Session expired. Please start again."));
        await removeSession();
        return true;
      }
      const cb = session.last_callback_data;
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(
          env,
          chatId,
          ...renderCommunityPicker(picker, ORG_PICKER_TITLE, { replace: true, skipLabel: "No community" })
        );
      } else if (result === "done" || result === "skip") {
        if (result === "done") session.pressed_answer = pickedAnswer(picker);
        session.organization_communities = result === "skip" ? [] : pickedCommunities(picker);
        await showRecordCard(sendMessage, env, chatId, session, persistSession);
      } else if (typeof result === "object") {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(env, chatId, errorMessage("Please use the buttons to select communities, then press Done."));
      }
      return true;
    }
    case "awaiting_card":
    case "awaiting_card_field":
      return handleCardStep(sendMessage, env, chatId, text, session, persistSession, cardHeader, async () => {
        // A new organization gets its OpenStreetMap location first; anything else is saved now.
        if (session.organization) {
          await lookupOsmAndContinue(sendMessage, env, chatId, session, persistSession, removeSession);
        } else {
          await save(sendMessage, env, chatId, session, removeSession, null);
        }
      });
    case "awaiting_osm_node": {
      const cb = session.last_callback_data;
      if (cb === "osm:search") {
        setStep(session, "awaiting_osm_name");
        await persistSession();
        await sendMessage(env, chatId, "Which name should I search OpenStreetMap for?");
        return true;
      }
      const choice = cb && cb.startsWith("osmnode:") ? cb.slice("osmnode:".length) : null;
      if (!choice || (choice !== "none" && !(session.osm_options || []).includes(choice))) {
        await sendMessage(env, chatId, errorMessage("Please choose a place from the buttons, or 'None of these'."));
        return true;
      }
      await save(sendMessage, env, chatId, session, removeSession, choice === "none" ? null : choice);
      return true;
    }
    case "awaiting_osm_name": {
      const name = text?.trim();
      if (!name) {
        await sendMessage(env, chatId, errorMessage("Please type the name to search for."));
        return true;
      }
      session.osm_name = name;
      await lookupOsmAndContinue(sendMessage, env, chatId, session, persistSession, removeSession);
      return true;
    }
    default:
      return false;
  }
}
