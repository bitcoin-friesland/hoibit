/**
 * /find: looks up contacts and organizations by part of the name. One match shows its card right
 * away; more are listed as buttons that open the card (show:…, see helpers/record.ts), so the flow
 * ends once something is found.
 *
 * Steps: find_start (with the name typed after /find in session.query, if any) and find_query.
 */
import { errorMessage } from "../helpers/messaging";
import { recordCard, recordData, type RecordRef } from "../helpers/record";
import { setStep } from "../helpers/session";
import type { FlowHandler, InlineKeyboardButton } from "../types";

const FIND_MAX_RESULTS = 8;
export const FIND_PROMPT = "Who or what are you looking for? Type part of the name of a contact or organization.";

export const handleFindFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  if (session.step !== "find_start" && session.step !== "find_query") {
    await sendMessage(env, chatId, errorMessage("Unknown step in find flow. Type /cancel to start over."));
    await removeSession();
    return;
  }
  const query = (session.step === "find_start" ? session.query : text)?.trim();
  if (session.step === "find_start") {
    delete session.query;
    setStep(session, "find_query");
    await persistSession();
    if (!query) {
      await sendMessage(env, chatId, FIND_PROMPT);
      return;
    }
  }
  if (!query || query.length < 2) {
    await sendMessage(env, chatId, errorMessage("Please type at least 2 letters of the name."));
    return;
  }

  let found: { ref: RecordRef; label: string }[];
  try {
    const [contacts, organizations] = await Promise.all([
      env.crmApi.searchContacts(query),
      env.crmApi.searchOrganizations({ name: query })
    ]);
    found = [
      ...contacts.map(c => ({
        ref: { kind: "contact" as const, id: c.id },
        label: `👤 ${c.organization_name ? `${c.name} (${c.organization_name})` : c.name}`
      })),
      ...organizations.map(o => {
        // The place tells organizations with the same name apart.
        const place = o.region || o.community_name;
        return {
          ref: { kind: "organization" as const, id: o.id },
          label: `🏢 ${place ? `${o.name} · ${place}` : o.name}`
        };
      })
    ];
  } catch (e) {
    console.error("Finding contacts and organizations failed", e);
    await sendMessage(env, chatId, errorMessage("Searching failed. Please type the name again."));
    return;
  }

  if (found.length === 0) {
    await sendMessage(env, chatId, `Nothing found for "${query}". Type another name.`);
    return;
  }
  if (found.length === 1) {
    let card;
    try {
      card = await recordCard(env, found[0].ref);
    } catch (e) {
      console.error("Loading a card failed", e);
    }
    if (!card) {
      await sendMessage(env, chatId, errorMessage("Loading it failed. Please type the name again."));
      return;
    }
    await removeSession();
    await sendMessage(env, chatId, card.text, card.options);
    return;
  }
  const shown = found.slice(0, FIND_MAX_RESULTS);
  const keyboard: InlineKeyboardButton[][] = shown.map(f => [
    { text: f.label, callback_data: recordData("show", f.ref) }
  ]);
  const more =
    found.length > shown.length
      ? `\nShowing ${shown.length} of ${found.length}. Use /find with more of the name to narrow it down.`
      : "";
  await removeSession();
  await sendMessage(env, chatId, `Found for "${query}":${more}`, { reply_markup: { inline_keyboard: keyboard } });
};
