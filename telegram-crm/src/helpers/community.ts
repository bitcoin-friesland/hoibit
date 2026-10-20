/**
 * Community selection helpers for interactive flows (contacts and team member invites).
 *
 * Telegram delivers every button press as a separate update, so the picker keeps its state
 * in the session (a plain object returned by startCommunityPicker) instead of in callbacks.
 *
 * Usage in a flow step:
 *   session.picker = await startCommunityPicker(env, session.telegram_id);
 *   await sendMessage(env, chatId, ...renderCommunityPicker(session.picker, title));
 *   // next update(s):
 *   const result = await handleCommunityPickerInput(env, session.picker, session.last_callback_data);
 *   // "updated" -> render again, "done"/"skip" -> continue with pickedCommunities(session.picker)
 *
 * Buttons: community:<id> (toggle), choose_other (country list), country:<index>, back, done, skip.
 */
import type { PickedCommunity, SendOptions } from "../types";

export interface CommunityPicker {
  // ids of the team member's own communities, always shown first
  own: number[];
  known: Record<number, { name: string; region: string | null }>;
  selected: number[];
  countries: string[] | null;
  country: string | null;
  countryIds: number[] | null;
}

export type PickerResult = "updated" | "done" | "skip" | "invalid" | { error: string };

/**
 * Creates picker state, preloaded with the team member's own communities.
 */
export async function startCommunityPicker(env: Env, telegramId: string | undefined): Promise<CommunityPicker> {
  let own: { id: number; name: string; region: string | null }[] = [];
  try {
    if (telegramId) own = await env.crmApi.teamMemberCommunities(telegramId);
  } catch {
    own = [];
  }
  return {
    own: own.map(c => c.id),
    known: Object.fromEntries(own.map(c => [c.id, { name: c.name, region: c.region || null }])),
    selected: [],
    countries: null,
    country: null,
    countryIds: null
  };
}

function communityButton(state: CommunityPicker, id: number) {
  return [
    {
      text: `${state.selected.includes(id) ? "✅ " : ""}${state.known[id].name}`,
      callback_data: `community:${id}`
    }
  ];
}

/**
 * Returns [text, { reply_markup }] for the current view, ready for sendMessage(env, chatId, ...).
 * title is shown on the main view (own communities + selections from other countries).
 */
export function renderCommunityPicker(state: CommunityPicker, title: string): [string, SendOptions] {
  if (state.countryIds) {
    const rows = state.countryIds.map(id => communityButton(state, id));
    rows.push(
      [{ text: "Back to countries", callback_data: "choose_other" }],
      [{ text: "Done", callback_data: "done" }]
    );
    return [`Select communities in ${state.country}:`, { reply_markup: { inline_keyboard: rows } }];
  }
  if (state.countries) {
    const rows = state.countries.map((country, i) => [{ text: country, callback_data: `country:${i}` }]);
    rows.push([{ text: "Back", callback_data: "back" }]);
    return ["Choose a country:", { reply_markup: { inline_keyboard: rows } }];
  }
  const ids = [...state.own, ...state.selected.filter(id => !state.own.includes(id))];
  const rows = ids.map(id => communityButton(state, id));
  rows.push(
    [{ text: "Choose other communities", callback_data: "choose_other" }],
    [{ text: "Done", callback_data: "done" }],
    [{ text: "Skip", callback_data: "skip" }]
  );
  return [title, { reply_markup: { inline_keyboard: rows } }];
}

/**
 * Applies one button press to the picker state.
 * Returns "updated" (render again), "done", "skip", "invalid", or { error } when a lookup failed.
 */
export async function handleCommunityPickerInput(
  env: Env,
  state: CommunityPicker,
  cb: string | null | undefined
): Promise<PickerResult> {
  if (cb && cb.startsWith("community:")) {
    const id = Number(cb.slice("community:".length));
    if (!state.known[id]) return "invalid";
    state.selected = state.selected.includes(id) ? state.selected.filter(x => x !== id) : [...state.selected, id];
    return "updated";
  }
  if (cb === "choose_other") {
    try {
      state.countries = await env.crmApi.communityCountries();
    } catch {
      return { error: "Could not load countries." };
    }
    state.country = null;
    state.countryIds = null;
    return "updated";
  }
  if (cb && cb.startsWith("country:")) {
    const country = state.countries && state.countries[Number(cb.slice("country:".length))];
    if (!country) return "invalid";
    let communities;
    try {
      communities = await env.crmApi.communities(country);
    } catch {
      return { error: "Could not load communities." };
    }
    for (const c of communities) state.known[c.id] = { name: c.name, region: c.region || null };
    state.country = country;
    state.countryIds = communities.map(c => c.id);
    return "updated";
  }
  if (cb === "back") {
    state.countries = null;
    state.country = null;
    state.countryIds = null;
    return "updated";
  }
  if (cb === "done") return "done";
  if (cb === "skip") return "skip";
  return "invalid";
}

/**
 * Selected communities as [{ id, name, region }].
 */
export function pickedCommunities(state: CommunityPicker): PickedCommunity[] {
  return state.selected.map(id => ({ id, ...state.known[id] }));
}
