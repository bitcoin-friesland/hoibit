/**
 * Editing a saved contact or organization: the ✏️ Edit button of its card (edit:c:<id> or
 * edit:o:<id>, see helpers/record.ts) starts this flow at edit_start. It shows the overview card
 * of helpers/card.ts with the name and the optional details; Save stores only what changed
 * (updateContact / updateOrg) and shows the card again.
 *
 * Besides the typed details the card has actions this flow asks for itself: a contact's type and
 * organization, an organization's communities, the team members who handle it and its place on
 * OpenStreetMap. Each returns to the card; nothing is saved before Save.
 */
import { handleCardStep, showCard, type CardActions, type CardHeader } from "../helpers/card";
import {
  handleCommunityPickerInput,
  pickedAnswer,
  pickedCommunities,
  renderCommunityPicker,
  startCommunityPicker
} from "../helpers/community";
import { errorMessage, successMessage } from "../helpers/messaging";
import { recordCard } from "../helpers/record";
import { setStep } from "../helpers/session";
import { INVALID_ORGANIZATION_NAME, isValidOrganizationName } from "../helpers/validation";
import { organizationButtons, ownCommunityId } from "./contact";
import {
  askOsmPlace,
  ORG_MAX_RESULTS,
  ORG_PICKER_TITLE,
  OSM_SEARCH_BUTTON,
  osmLabel,
  searchOsmPlaces
} from "./organization";
import type { ChatId, FlowHandler, InlineKeyboardButton, SendMessage, SendOptions, Session } from "../types";

const SAVE_FAILED = "Saving failed, nothing was saved. Please try again.";

// Per session key of the card: the field of updateContact / updateOrg it is saved as.
const CONTACT_FIELDS = { name: "name", email: "email", phone: "phone", nostr_npub: "nostr_npub" } as const;
const ORGANIZATION_FIELDS = {
  organization: "name",
  organization_category: "category",
  organization_address: "address",
  organization_phone: "phone",
  organization_email: "email",
  organization_website: "website",
  organization_nostr_npub: "nostr_npub",
  organization_follow_up_on: "follow_up_on"
} as const;

type CardKey = keyof typeof CONTACT_FIELDS | keyof typeof ORGANIZATION_FIELDS;

const TYPES = { consumer: "Consumer", entrepreneur: "Entrepreneur" } as const;

const BACK_BUTTON: InlineKeyboardButton = { text: "⬅️ Back", callback_data: "card:back" };

const fieldsOf = (session: Session): Record<string, string> =>
  session.edit_target === "organization" ? ORGANIZATION_FIELDS : CONTACT_FIELDS;

const handlerIds = (session: Session) => [...(session.handler_ids ?? [])].sort((a, b) => a - b).join(",");

const communityIds = (session: Session) =>
  (session.organization_communities ?? [])
    .map(c => c.id)
    .sort((a, b) => a - b)
    .join(",");

// The values of the actions, comparable with edit_original like the typed details.
function actionValues(session: Session): Record<string, string | null> {
  if (session.edit_target === "organization") {
    return {
      community_ids: communityIds(session),
      team_member_ids: handlerIds(session),
      location_osm_id: session.location_osm_id ?? null
    };
  }
  return {
    type: session.type ?? null,
    organization_id: session.organization_id ? String(session.organization_id) : null
  };
}

const header: CardHeader = session => [
  session.edit_target === "organization" ? "✏️ Edit organization" : "✏️ Edit contact"
];

const handlerNames = (session: Session) =>
  (session.handler_ids ?? []).map(id => session.handler_choices?.[String(id)] ?? "?").join(", ");

function locationLine(session: Session) {
  if (session.location_label) return session.location_label;
  return session.location_osm_id ? `https://www.openstreetmap.org/${session.location_osm_id}` : "—";
}

const actions: CardActions = session =>
  session.edit_target === "organization"
    ? [
        {
          key: "communities",
          button: "👥 Communities",
          line: `👥 Communities: ${(session.organization_communities ?? []).map(c => c.name).join(", ") || "—"}`
        },
        {
          key: "handlers",
          button: "🤝 Handled by",
          line: `🤝 Handled by: ${handlerNames(session) || "—"}`
        },
        { key: "location", button: "📍 Location", line: `📍 Location: ${locationLine(session)}` }
      ]
    : [
        { key: "type", button: "🏷️ Type", line: `🏷️ Type: ${session.type ? TYPES[session.type] : "—"}` },
        {
          key: "contact_organization",
          button: "🏢 Organization",
          line: `🏢 Organization: ${session.organization_label ?? "—"}`
        }
      ];

const recordOf = (session: Session) =>
  session.edit_target === "organization"
    ? { kind: "organization" as const, id: session.organization_id ?? 0 }
    : { kind: "contact" as const, id: session.contact_id ?? 0 };

// Puts the saved details in the session, for the card; false when the record no longer exists.
async function load(env: Env, session: Session) {
  if (session.edit_target === "organization") {
    const [org, communities] = await Promise.all([
      env.crmApi.organizationDetails(session.organization_id ?? 0, 0),
      env.crmApi.organizationCommunities(session.organization_id ?? 0)
    ]);
    if (!org) return false;
    session.organization = org.name;
    session.organization_website = org.website;
    session.organization_nostr_npub = org.nostr_npub;
    session.organization_category = org.category;
    session.organization_address = org.address;
    session.organization_phone = org.phone;
    session.organization_email = org.email;
    session.organization_follow_up_on = org.follow_up_on;
    session.handler_ids = org.handled_by.map(h => h.id);
    // The names of the current handlers; the picker adds the rest of the team.
    session.handler_choices = Object.fromEntries(org.handled_by.map(h => [String(h.id), h.name ?? "?"]));
    session.organization_communities = communities.map(c => ({ id: c.id, name: c.name, region: c.region }));
    session.location_osm_id = org.location_osm_id;
  } else {
    const contact = await env.crmApi.contactDetails(session.contact_id ?? 0, 0);
    if (!contact) return false;
    session.name = contact.name;
    // The card edits the first email address and phone number; any others stay as they are.
    session.email = contact.emails[0] ?? null;
    session.phone = contact.phones[0] ?? null;
    session.nostr_npub = contact.nostr_npub;
    if (contact.type === "consumer" || contact.type === "entrepreneur") session.type = contact.type;
    session.organization_id = contact.organization_id ?? undefined;
    session.organization_label = contact.organization_name ?? undefined;
  }
  session.edit_original = {
    ...Object.fromEntries(Object.keys(fieldsOf(session)).map(key => [key, session[key as CardKey] ?? null])),
    ...actionValues(session)
  };
  return true;
}

async function save(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  removeSession: () => Promise<void>
) {
  const original = session.edit_original ?? {};
  const changes: Record<string, string | null> = {};
  for (const [key, field] of Object.entries(fieldsOf(session))) {
    const value = session[key as CardKey] ?? null;
    if (value !== (original[key] ?? null)) changes[field] = value;
  }
  const changed = (key: string) => actionValues(session)[key] !== (original[key] ?? null);
  const ref = recordOf(session);
  const updatedBy = session.created_by || null;
  let anything = false;
  try {
    let res;
    if (ref.kind === "organization") {
      const update = {
        ...changes,
        ...(changed("location_osm_id") ? { location_osm_id: session.location_osm_id ?? null } : {}),
        ...(changed("community_ids") ? { community_ids: (session.organization_communities ?? []).map(c => c.id) } : {}),
        ...(changed("team_member_ids") ? { team_member_ids: session.handler_ids ?? [] } : {})
      };
      anything = Object.keys(update).length > 0;
      if (anything) res = await env.crmApi.updateOrg({ organization_id: ref.id, ...update, updated_by: updatedBy });
    } else {
      const update = {
        ...changes,
        ...(changed("type") && session.type ? { type: session.type } : {}),
        ...(changed("organization_id") ? { organization_id: session.organization_id ?? null } : {})
      };
      anything = Object.keys(update).length > 0;
      if (anything) res = await env.crmApi.updateContact({ contact_id: ref.id, ...update, updated_by: updatedBy });
    }
    if (res && !res.ok) throw new Error(res.error);
  } catch (e) {
    console.error("Saving an edit failed", e);
    await sendMessage(env, chatId, errorMessage(SAVE_FAILED));
    return;
  }
  const name = ref.kind === "organization" ? session.organization : session.name;
  await removeSession();
  await sendMessage(env, chatId, anything ? successMessage(`"${name}" updated.`) : "Nothing changed.");
  try {
    const card = await recordCard(env, ref);
    if (card) await sendMessage(env, chatId, card.text, card.options);
  } catch (e) {
    // The change is saved; only showing it again failed.
    console.error("Loading a card failed", e);
  }
}

// The team members to tick as handlers of the organization, redrawn in place with replace.
function handlerPicker(session: Session, ids: number[], replace = false): [string, SendOptions] {
  const picked = session.handler_picked ?? [];
  const rows: InlineKeyboardButton[][] = ids.map(id => [
    {
      text: `${picked.includes(id) ? "✅ " : ""}${session.handler_choices?.[String(id)] ?? "?"}`,
      callback_data: `handler:${id}`
    }
  ]);
  rows.push([{ text: "Done", callback_data: "handlers:done" }], [BACK_BUTTON]);
  return [
    `Who handles "${session.organization}"? They follow it up.`,
    { reply_markup: { inline_keyboard: rows }, ...(replace ? { replace } : {}) }
  ];
}

// Asks for the name of the contact's organization; Unlink only when it has one.
async function askOrganization(sendMessage: SendMessage, env: Env, chatId: ChatId, session: Session) {
  const buttons = [BACK_BUTTON];
  if (session.organization_id) buttons.push({ text: "🗑️ Unlink", callback_data: "card:remove" });
  await sendMessage(env, chatId, `Which organization does ${session.name} belong to? Type part of the name.`, {
    reply_markup: { inline_keyboard: [buttons] },
    accepts_text: true
  });
}

// Searches OpenStreetMap and asks which place the organization is; Remove only when it has one.
async function askLocation(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  session: Session,
  persistSession: () => Promise<void>
) {
  const results = await searchOsmPlaces(env, chatId, session);
  session.osm_choices = Object.fromEntries(results.map(item => [item.id, osmLabel(item)]));
  setStep(session, "edit_location");
  await persistSession();
  const more: InlineKeyboardButton[][] = [[OSM_SEARCH_BUTTON]];
  if (session.location_osm_id) more.push([{ text: "🗑️ Remove location", callback_data: "card:remove" }]);
  more.push([BACK_BUTTON]);
  await askOsmPlace(sendMessage, env, chatId, session, results, more);
}

/**
 * The steps of the card's actions; returns false (and does nothing) for any other step. Back
 * returns to the card from each of them.
 */
async function handleActionStep(
  sendMessage: SendMessage,
  env: Env,
  chatId: ChatId,
  text: string | undefined,
  session: Session,
  persistSession: () => Promise<void>
): Promise<boolean> {
  const cb = session.last_callback_data;
  const backToCard = () => showCard(sendMessage, env, chatId, session, persistSession, header, actions);
  switch (session.step) {
    case "awaiting_card": {
      if (cb === "card:type") {
        setStep(session, "edit_type");
        await persistSession();
        await sendMessage(env, chatId, `Is ${session.name} a consumer or an entrepreneur?`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: TYPES.consumer, callback_data: "type:consumer" },
                { text: TYPES.entrepreneur, callback_data: "type:entrepreneur" }
              ],
              [BACK_BUTTON]
            ]
          }
        });
      } else if (cb === "card:contact_organization") {
        setStep(session, "edit_organization");
        await persistSession();
        await askOrganization(sendMessage, env, chatId, session);
      } else if (cb === "card:communities") {
        session.org_picker = await startCommunityPicker(env, session.telegram_id, session.organization_communities);
        setStep(session, "edit_communities");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          ...renderCommunityPicker(session.org_picker, ORG_PICKER_TITLE, { skipLabel: "Keep unchanged" })
        );
      } else if (cb === "card:location") {
        session.osm_name = undefined;
        await askLocation(sendMessage, env, chatId, session, persistSession);
      } else if (cb === "card:handlers") {
        let members;
        try {
          members = await env.crmApi.listTeamMembers();
        } catch (e) {
          console.error("Loading the team failed", e);
          await sendMessage(env, chatId, errorMessage("Loading the team failed. Please try again."));
          return true;
        }
        session.handler_choices = {
          ...session.handler_choices,
          ...Object.fromEntries(members.map(m => [String(m.id), m.name ?? m.telegram_username ?? m.telegram_id]))
        };
        session.handler_picked = [...(session.handler_ids ?? [])];
        setStep(session, "edit_handlers");
        await persistSession();
        await sendMessage(
          env,
          chatId,
          ...handlerPicker(
            session,
            members.map(m => m.id)
          )
        );
      } else {
        return false;
      }
      return true;
    }
    case "edit_type": {
      const type = cb?.startsWith("type:") ? cb.slice("type:".length) : undefined;
      if (type === "consumer" || type === "entrepreneur") session.type = type;
      else if (cb !== "card:back") {
        await sendMessage(env, chatId, errorMessage("Please choose Consumer or Entrepreneur, or tap Back."));
        return true;
      }
      await backToCard();
      return true;
    }
    case "edit_organization": {
      if (cb === "card:back") {
        await backToCard();
        return true;
      }
      if (cb === "card:remove") {
        session.organization_id = undefined;
        session.organization_label = undefined;
        await backToCard();
        return true;
      }
      if (cb?.startsWith("select_org:")) {
        const id = cb.slice("select_org:".length);
        const name = session.org_choices?.[id];
        if (!name) {
          await sendMessage(env, chatId, errorMessage("Please choose an organization from the buttons."));
          return true;
        }
        session.organization_id = Number(id);
        session.organization_label = name;
        await backToCard();
        return true;
      }
      const name = text?.trim();
      if (!isValidOrganizationName(name)) {
        await sendMessage(env, chatId, errorMessage(INVALID_ORGANIZATION_NAME));
        return true;
      }
      let found;
      try {
        found = await env.crmApi.searchOrganizations({ name, community_id: await ownCommunityId(env, session) });
      } catch (e) {
        console.error("Searching organizations failed", e);
        await sendMessage(env, chatId, errorMessage("Searching organizations failed. Please type the name again."));
        return true;
      }
      const orgs = found.slice(0, ORG_MAX_RESULTS);
      session.org_choices = Object.fromEntries(orgs.map(o => [String(o.id), o.name]));
      await persistSession();
      if (orgs.length === 0) {
        await sendMessage(
          env,
          chatId,
          `No organization found with the name "${name}". Type another name, or tap Back. A new organization can be added with /neworg.`,
          { reply_markup: { inline_keyboard: [[BACK_BUTTON]] }, accepts_text: true }
        );
        return true;
      }
      const more =
        found.length > orgs.length
          ? ` Showing ${orgs.length} of ${found.length}; type more of the name to narrow it down.`
          : " Or type another name.";
      await sendMessage(env, chatId, `Which organization is it?${more}`, {
        reply_markup: { inline_keyboard: [...organizationButtons(orgs), [BACK_BUTTON]] },
        accepts_text: true
      });
      return true;
    }
    case "edit_communities": {
      const picker = session.org_picker;
      if (!picker) {
        await backToCard();
        return true;
      }
      session.last_callback_data = null;
      const result = await handleCommunityPickerInput(env, picker, cb);
      await persistSession();
      if (result === "updated") {
        await sendMessage(
          env,
          chatId,
          ...renderCommunityPicker(picker, ORG_PICKER_TITLE, { replace: true, skipLabel: "Keep unchanged" })
        );
      } else if (result === "done") {
        session.pressed_answer = pickedAnswer(picker);
        session.organization_communities = pickedCommunities(picker);
        await backToCard();
      } else if (result === "skip") {
        await backToCard();
      } else if (typeof result === "object") {
        await sendMessage(env, chatId, errorMessage(result.error));
      } else {
        await sendMessage(env, chatId, errorMessage("Please use the buttons to select communities, then press Done."));
      }
      return true;
    }
    case "edit_handlers": {
      if (cb === "card:back") {
        await backToCard();
        return true;
      }
      if (cb === "handlers:done") {
        session.handler_ids = session.handler_picked ?? [];
        session.pressed_answer = handlerNames(session) || "Nobody";
        await backToCard();
        return true;
      }
      const id = cb?.startsWith("handler:") ? Number(cb.slice("handler:".length)) : undefined;
      if (id === undefined || !session.handler_choices?.[String(id)]) {
        await sendMessage(env, chatId, errorMessage("Please tick team members, then tap Done, or tap Back."));
        return true;
      }
      const picked = session.handler_picked ?? [];
      session.handler_picked = picked.includes(id) ? picked.filter(p => p !== id) : [...picked, id];
      session.last_callback_data = null;
      await persistSession();
      const shown = Object.keys(session.handler_choices).map(Number);
      await sendMessage(env, chatId, ...handlerPicker(session, shown, true));
      return true;
    }
    case "edit_location": {
      if (cb === "card:back") {
        await backToCard();
        return true;
      }
      if (cb === "card:remove") {
        session.location_osm_id = null;
        session.location_label = undefined;
        await backToCard();
        return true;
      }
      if (cb === "osm:search") {
        setStep(session, "edit_location_name");
        await persistSession();
        await sendMessage(env, chatId, "Which name should I search OpenStreetMap for?", {
          reply_markup: { inline_keyboard: [[BACK_BUTTON]] },
          accepts_text: true
        });
        return true;
      }
      const id = cb?.startsWith("osmnode:") ? cb.slice("osmnode:".length) : undefined;
      const label = id ? session.osm_choices?.[id] : undefined;
      if (!id || !label) {
        await sendMessage(env, chatId, errorMessage("Please choose a place from the buttons, or tap Back."));
        return true;
      }
      session.location_osm_id = id;
      session.location_label = label;
      await backToCard();
      return true;
    }
    case "edit_location_name": {
      if (cb === "card:back") {
        await backToCard();
        return true;
      }
      const name = text?.trim();
      if (!name) {
        await sendMessage(env, chatId, errorMessage("Please type the name to search for, or tap Back."));
        return true;
      }
      session.osm_name = name;
      await askLocation(sendMessage, env, chatId, session, persistSession);
      return true;
    }
    default:
      return false;
  }
}

export const handleEditFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  if (session.step === "edit_start") {
    let found;
    try {
      found = await load(env, session);
    } catch (e) {
      console.error("Loading a record to edit failed", e);
      await sendMessage(env, chatId, errorMessage("Something went wrong. Please try again."));
      await removeSession();
      return;
    }
    if (!found) {
      await sendMessage(env, chatId, errorMessage("This no longer exists."));
      await removeSession();
      return;
    }
    await showCard(sendMessage, env, chatId, session, persistSession, header, actions);
    return;
  }
  if (await handleActionStep(sendMessage, env, chatId, text, session, persistSession)) return;
  const handled = await handleCardStep(
    sendMessage,
    env,
    chatId,
    text,
    session,
    persistSession,
    header,
    () => save(sendMessage, env, chatId, session, removeSession),
    actions
  );
  if (handled) return;
  await sendMessage(env, chatId, errorMessage("Unknown step in edit flow. Type /cancel to start over."));
  await removeSession();
};
