/**
 * The Bitcoin status of a saved organization: 📊 Status on its card, and 📊 Update status after
 * a conversation with one of its entrepreneurs. Like the card's buttons these belong to no
 * session: status:<organization id> asks for the new status, status:<organization id>:<status
 * id> sets it.
 */
import { ORG_STATUSES } from "./organization";
import type { InlineKeyboardButton, SendOptions } from "../types";

const STATUSES = Object.values(ORG_STATUSES);

export const statusData = (organizationId: number, statusId?: number) =>
  statusId === undefined ? `status:${organizationId}` : `status:${organizationId}:${statusId}`;

// What a status:… button is about; undefined for other data.
export function parseStatusData(data: string): { organizationId: number; statusId?: number } | undefined {
  const match = /^status:(\d+)(?::(\d+))?$/.exec(data);
  if (!match) return undefined;
  return { organizationId: Number(match[1]), ...(match[2] ? { statusId: Number(match[2]) } : {}) };
}

// A button that asks for the new status of an organization.
export const statusButton = (organizationId: number, text = "📊 Status"): InlineKeyboardButton => ({
  text,
  callback_data: statusData(organizationId)
});

/**
 * The question for the new status of the organization, with the current one ticked; undefined
 * when it no longer exists. Throws when crm-api cannot be reached.
 */
export async function statusQuestion(
  env: Env,
  organizationId: number
): Promise<{ text: string; options: SendOptions } | undefined> {
  const org = await env.crmApi.organizationDetails(organizationId, 0);
  if (!org) return undefined;
  const now = org.status_label ? ` It is now: ${org.status_label}.` : "";
  return {
    text: `What is the Bitcoin status of "${org.name}"?${now}`,
    options: {
      reply_markup: {
        inline_keyboard: STATUSES.map(s => [
          { text: s.id === org.status ? `✓ ${s.label}` : s.label, callback_data: statusData(organizationId, s.id) }
        ])
      }
    }
  };
}

/**
 * Sets the status; returns what the pressed question should say below it, or undefined when it
 * could not be saved (logged). Throws when crm-api cannot be reached.
 */
export async function setStatus(env: Env, organizationId: number, statusId: number, memberId: number) {
  const status = STATUSES.find(s => s.id === statusId);
  if (!status) return undefined;
  const res = await env.crmApi.updateOrg({ organization_id: organizationId, status: statusId, updated_by: memberId });
  if (!res.ok) {
    console.error("Updating an organization's status was refused", res);
    return undefined;
  }
  return res.changed ? status.label : `${status.label} (unchanged)`;
}
