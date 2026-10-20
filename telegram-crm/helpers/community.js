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

async function fetchUserCommunities(env, userId) {
  // Fetch user's current communities from crm-api
  const url = `${env.CRM_API_URL}/team_member_communities?telegram_id=${userId}`;
  const res = await env.crmApi.fetch(new Request(url));
  if (!res.ok) throw new Error("Failed to fetch user communities");
  return await res.json();
}

export async function fetchCountries(env) {
  // Fetch unique countries from bitcoin_communities table
  const url = `${env.CRM_API_URL}/community_countries`;
  const res = await env.crmApi.fetch(new Request(url));
  if (!res.ok) throw new Error("Failed to fetch countries");
  return await res.json();
}

export async function fetchCommunitiesByCountry(env, country) {
  // Fetch all communities in a country
  const url = `${env.CRM_API_URL}/bitcoin_communities?country=${encodeURIComponent(country)}`;
  const res = await env.crmApi.fetch(new Request(url));
  if (!res.ok) throw new Error("Failed to fetch communities");
  return await res.json();
}

/**
 * Returns the communities of a team member (by Telegram user id).
 */
export async function selectCommunitiesList(env, userId) {
  return await fetchUserCommunities(env, userId);
}

/**
 * Creates picker state, preloaded with the team member's own communities.
 */
export async function startCommunityPicker(env, telegramId) {
  let own = [];
  try {
    own = await fetchUserCommunities(env, telegramId);
  } catch (e) {
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

function communityButton(state, id) {
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
export function renderCommunityPicker(state, title) {
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
 * Returns "updated" (render again), "done", "skip", "invalid", or { error } when a fetch failed.
 */
export async function handleCommunityPickerInput(env, state, cb) {
  if (cb && cb.startsWith("community:")) {
    const id = Number(cb.slice("community:".length));
    if (!state.known[id]) return "invalid";
    state.selected = state.selected.includes(id) ? state.selected.filter(x => x !== id) : [...state.selected, id];
    return "updated";
  }
  if (cb === "choose_other") {
    try {
      state.countries = await fetchCountries(env);
    } catch (e) {
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
      communities = await fetchCommunitiesByCountry(env, country);
    } catch (e) {
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
export function pickedCommunities(state) {
  return state.selected.map(id => ({ id, ...state.known[id] }));
}
