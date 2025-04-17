/**
 * Community selection helper for interactive flows.
 * Supports selection of Bitcoin communities for contacts or team members.
 * 
 * Usage:
 *   await selectCommunities({
 *     sendMessage, env, chatId, session, persistSession, removeSession,
 *     userId, // team_member id for filtering memberships
 *     onComplete, // callback(communities) when selection is done
 *     onSkip,     // callback() when skipped
 *     context     // optional: 'contact', 'teammember', etc.
 *   });
 */

async function fetchUserCommunities(env, userId) {
  // Fetch user's current communities from crm-api
  const url = `${env.CRM_API_URL}/team_member_communities?telegram_id=${userId}`;
  const res = await env.crmApi.fetch(new Request(url, {
    headers: { 'Authorization': `Bearer ${env.API_TOKEN}` }
  }));
  if (!res.ok) throw new Error('Failed to fetch user communities');
  return await res.json();
}

export async function fetchCountries(env) {
  // Fetch unique countries from bitcoin_communities table
  const url = `${env.CRM_API_URL}/community_countries`;
  const res = await env.crmApi.fetch(new Request(url, {
    headers: { 'Authorization': `Bearer ${env.API_TOKEN}` }
  }));
  if (!res.ok) throw new Error('Failed to fetch countries');
  return await res.json();
}

export async function fetchCommunitiesByCountry(env, country) {
  // Fetch all communities in a country
  const url = `${env.CRM_API_URL}/bitcoin_communities?country=${encodeURIComponent(country)}`;
  const res = await env.crmApi.fetch(new Request(url, {
    headers: { 'Authorization': `Bearer ${env.API_TOKEN}` }
  }));
  if (!res.ok) throw new Error('Failed to fetch communities');
  return await res.json();
}

export async function selectCommunities({
  sendMessage, env, chatId, session, persistSession, removeSession,
  userId, onComplete, onSkip, context = 'contact'
}) {
  // Step 1: Show user's current communities, plus 'Choose other communities' and 'Skip'
  const userCommunities = await fetchUserCommunities(env, userId);
  const buttons = userCommunities.map(c => [{
    text: c.name,
    callback_data: `community:${c.id}`
  }]);
  buttons.push(
    [{ text: 'Choose other communities', callback_data: 'choose_other' }],
    [{ text: 'Skip', callback_data: 'skip' }]
  );
  await sendMessage(env, chatId, 'Select Bitcoin communities for this organization:', {
    reply_markup: { inline_keyboard: buttons }
  });

  // The rest of the flow (handling callbacks, subflow for country/community selection, multi-select, etc.)
  // should be implemented in the flow handler using this helper as a stateful step.
  // This file provides fetchers and the initial prompt; the flow should handle user responses and call
  // fetchCountries, fetchCommunitiesByCountry, and re-render as needed.
}

/**
 * Returns all communities the user can select from (used for multi-select UI).
 * This fetches the same as fetchUserCommunities, but returns the array of communities.
 */
export async function selectCommunitiesList(env, userId) {
  // Fetch user's current communities from crm-api
  const url = `${env.CRM_API_URL}/team_member_communities?telegram_id=${userId}`;
  const res = await env.crmApi.fetch(new Request(url, {
    headers: { 'Authorization': `Bearer ${env.API_TOKEN}` }
  }));
  if (!res.ok) throw new Error('Failed to fetch user communities');
  return await res.json();
}
