/**
 * When an organization should next be contacted (organizations.follow_up_on), and /followups,
 * the list of what is due. ⏰ Follow-up on its card and after a conversation asks for the day;
 * like the status buttons these belong to no session: fu:<organization id> asks, and
 * fu:<organization id>:<days> sets the day that many days from today, fu:<id>:x removes it.
 * Only fu:<id>:date starts a session (mode "followup"), to type a day.
 */
import { followUpLabel, parseFutureDay, teamDay, teamDayIn } from "../helpers/day";
import { errorMessage, successMessage } from "../helpers/messaging";
import { recordData } from "../helpers/record";
import { setStep } from "../helpers/session";
import type { FlowHandler, InlineKeyboardButton, SendOptions } from "../types";

const DAY_PROMPT = "Type the day, like 12-01 or 12-01-2027.";
// /followups lists what is due up to this many days ahead.
const LIST_DAYS = 7;
// More buttons than this make the list hard to use; the rest is counted.
const LIST_MAX = 20;
const CHOICES: [string, number][] = [
  ["Tomorrow", 1],
  ["In a week", 7],
  ["In 2 weeks", 14],
  ["In a month", 30]
];

export const followUpData = (organizationId: number, choice?: number | "x" | "date") =>
  choice === undefined ? `fu:${organizationId}` : `fu:${organizationId}:${choice}`;

// What a fu:… button is about; undefined for other data.
export function parseFollowUpData(
  data: string
): { organizationId: number; choice?: number | "x" | "date" } | undefined {
  const match = /^fu:(\d+)(?::(\d+|x|date))?$/.exec(data);
  if (!match) return undefined;
  const organizationId = Number(match[1]);
  const raw = match[2];
  if (raw === undefined) return { organizationId };
  return { organizationId, choice: raw === "x" || raw === "date" ? raw : Number(raw) };
}

export const followUpButton = (organizationId: number, text = "⏰ Follow-up"): InlineKeyboardButton => ({
  text,
  callback_data: followUpData(organizationId)
});

/**
 * The question for the follow-up day of the organization; undefined when it no longer exists.
 * Throws when crm-api cannot be reached.
 */
export async function followUpQuestion(
  env: Env,
  organizationId: number
): Promise<{ text: string; options: SendOptions } | undefined> {
  const org = await env.crmApi.organizationDetails(organizationId, 0);
  if (!org) return undefined;
  const now = org.follow_up_on ? ` It is now: ${followUpLabel(org.follow_up_on)}.` : "";
  const rows: InlineKeyboardButton[][] = [
    CHOICES.slice(0, 2).map(([text, days]) => ({ text, callback_data: followUpData(organizationId, days) })),
    CHOICES.slice(2).map(([text, days]) => ({ text, callback_data: followUpData(organizationId, days) })),
    [{ text: "📅 Other date", callback_data: followUpData(organizationId, "date") }]
  ];
  if (org.follow_up_on) rows.push([{ text: "🗑️ No follow-up", callback_data: followUpData(organizationId, "x") }]);
  return {
    text: `When should "${org.name}" be followed up?${now}`,
    options: { reply_markup: { inline_keyboard: rows } }
  };
}

/**
 * Sets the follow-up day (null removes it); returns what the question should say below it, or
 * undefined when it could not be saved (logged). Throws when crm-api cannot be reached.
 */
export async function setFollowUp(env: Env, organizationId: number, day: string | null, memberId: number) {
  const res = await env.crmApi.updateOrg({ organization_id: organizationId, follow_up_on: day, updated_by: memberId });
  if (!res.ok) {
    console.error("Setting a follow-up was refused", res);
    return undefined;
  }
  return day ? followUpLabel(day) : "No follow-up";
}

// fu:<id>:<days> or fu:<id>:x: the day to save; undefined for other choices.
export const chosenDay = (choice: number | "x" | "date") =>
  choice === "x" ? null : choice === "date" ? undefined : teamDayIn(choice);

// Typing a follow-up day after 📅 Other date (step awaiting_follow_up_day).
export const handleFollowUpFlow: FlowHandler = async (
  sendMessage,
  env,
  chatId,
  text,
  session,
  persistSession = async () => {},
  removeSession = async () => {}
) => {
  if (session.step === "follow_up_start") {
    setStep(session, "awaiting_follow_up_day");
    await persistSession();
    await sendMessage(env, chatId, `When should "${session.organization}" be followed up? ${DAY_PROMPT}`);
    return;
  }
  const day = text ? parseFutureDay(text) : undefined;
  if (!day) {
    await sendMessage(
      env,
      chatId,
      errorMessage(text ? `"${text.trim()}" is not today or a day to come. ${DAY_PROMPT}` : DAY_PROMPT)
    );
    return;
  }
  let saved;
  try {
    saved = await setFollowUp(env, session.organization_id ?? 0, day, session.created_by ?? 0);
  } catch (e) {
    console.error("Setting a follow-up failed", e);
  }
  if (!saved) {
    await sendMessage(env, chatId, errorMessage("Saving failed, nothing was saved. Please type the day again."));
    return;
  }
  await removeSession();
  await sendMessage(env, chatId, successMessage(`"${session.organization}" will be followed up ${dayOn(day)}.`));
};

const dayOn = (day: string) => (day === teamDay(0) ? "today" : `on ${followUpLabel(day)}`);

/**
 * /followups: the organizations the member handles, or nobody handles, whose follow-up day is
 * within a week or has passed, the earliest first, each with a button to its card. Throws when
 * crm-api cannot be reached.
 */
export async function followUpList(env: Env, memberId: number): Promise<{ text: string; options: SendOptions }> {
  const until = teamDayIn(LIST_DAYS);
  const res = await env.crmApi.followUps({ until, team_member_id: memberId });
  if (!res.ok) throw new Error(res.error);
  const due = res.follow_ups;
  if (due.length === 0) return { text: `Nothing to follow up until ${followUpLabel(until)}. 🎉`, options: {} };
  const shown = due.slice(0, LIST_MAX);
  const lines = shown.map(f => {
    const who = f.handled_by.length > 0 ? f.handled_by.map(h => h.name ?? "?").join(", ") : "nobody";
    return `• ${followUpLabel(f.follow_up_on)} · ${f.name}${f.status_label ? ` · ${f.status_label}` : ""} · ${who}`;
  });
  const more = due.length > shown.length ? [`…and ${due.length - shown.length} more.`] : [];
  return {
    text: [`⏰ To follow up until ${followUpLabel(until)}:`, ...lines, ...more].join("\n"),
    options: {
      reply_markup: {
        inline_keyboard: shown.map(f => [
          { text: `🏢 ${f.name}`, callback_data: recordData("show", { kind: "organization", id: f.id }) }
        ])
      }
    }
  };
}
