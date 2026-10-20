import type CrmApi from "./index";
import type { Result } from "./types";

// Transitional: the HTTP API that telegram-crm used before it called crm-api over RPC.
// It maps each route onto the RPC method. Remove once telegram-crm uses RPC everywhere.

function fromResult(result: Result<object>): Response {
  if (!result.ok) return new Response(result.error, { status: result.status });
  const { ok: _ok, ...body } = result;
  return Object.keys(body).length > 0 ? Response.json(body) : new Response("OK");
}

export async function handleHttp(request: Request, api: CrmApi): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams;
  const route = `${request.method} ${url.pathname}`;
  // Untyped JSON from the old client; the RPC methods validate what they need.
  const body = async (): Promise<any> => request.json();
  try {
    switch (route) {
      case "POST /validate-user": {
        const { telegram_id } = await body();
        if (!telegram_id) return new Response("Missing telegram_id", { status: 400 });
        const member = await api.validateUser(telegram_id);
        return member ? Response.json(member) : new Response("User not found", { status: 404 });
      }
      case "GET /team_members/count":
        return Response.json({ count: await api.countTeamMembers() });
      case "GET /team_members":
        return Response.json(await api.listTeamMembers());
      case "POST /first-user":
        return fromResult(await api.firstUser(await body()));
      case "POST /team_member":
        return fromResult(await api.addTeamMember(await body()));
      case "PATCH /team_member":
        return fromResult(await api.updateTeamMember(await body()));
      case "POST /team_member/admin":
        return fromResult(await api.setAdmin(await body()));
      case "POST /delete-team-member":
        return fromResult(await api.deleteTeamMember(await body()));
      case "GET /team_member_communities": {
        const telegramId = query.get("telegram_id");
        if (!telegramId) return new Response("Missing telegram_id", { status: 400 });
        return Response.json(await api.teamMemberCommunities(telegramId));
      }
      case "GET /community_countries":
        return Response.json(await api.communityCountries());
      case "GET /communities":
      case "GET /bitcoin_communities":
        return Response.json(await api.communities(query.get("country")));
      case "GET /channels":
        return Response.json(await api.channels());
      case "GET /contact_types":
        return Response.json(await api.contactTypes());
      case "GET /organizations/search":
        return Response.json(
          await api.searchOrganizations({
            name: query.get("name"),
            domain: query.get("domain"),
            email: query.get("email"),
            community_id: query.get("community_id")
          })
        );
      case "GET /contacts/search":
        return Response.json(await api.searchContacts(query.get("name")));
      case "POST /newcontact":
        return fromResult(await api.newContact(await body()));
      case "POST /neworg":
        return fromResult(await api.newOrg(await body()));
      case "POST /log-conversation":
        return fromResult(await api.logConversation(await body()));
      case "POST /organization_communities":
        return fromResult(await api.setOrganizationCommunities(await body()));
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    console.error(`Error handling ${route}:`, error);
    return new Response("Internal server error", { status: 500 });
  }
}
