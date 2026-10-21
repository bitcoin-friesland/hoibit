import { WorkerEntrypoint } from "cloudflare:workers";
import { blocklist } from "./blocklist";
import { callTelegram, spamKeyboard } from "./telegram";

const BUTTON = /^spam:(\d+)(?::(yes|no))?$/;
const STALE = "This button is no longer active.";

// A notice the user must not miss: telegram-crm shows it in a box they close, not as a toast.
interface Alert {
  text: string;
  alert: true;
}

const confirmKeyboard = (email: number) => ({
  inline_keyboard: [
    [{ text: "✅ Delete and block sender", callback_data: `spam:${email}:yes` }],
    [{ text: "Cancel", callback_data: `spam:${email}:no` }]
  ]
});

async function setKeyboard(env: Env, messageId: number, keyboard: object) {
  await callTelegram(
    env,
    "editMessageReplyMarkup",
    JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, message_id: messageId, reply_markup: keyboard })
  );
}

/**
 * The spam button under every email. Telegram sends a press to the bot's webhook, telegram-crm,
 * which checks that a team member pressed it and passes it on here over its mailToTg service
 * binding. A press first asks for confirmation; "yes" blocks the sender and deletes the email's
 * messages. Later emails from a blocked sender are dropped (see index.ts).
 */
export class SpamButtons extends WorkerEntrypoint<Env> {
  // Returns the notice Telegram shows on the button.
  async press(data: string, chatId: number, messageId: number): Promise<string | Alert> {
    const match = BUTTON.exec(data);
    if (!match || String(chatId) !== String(this.env.TELEGRAM_CHAT_ID)) return STALE;
    const id = Number(match[1]);
    const list = blocklist(this.env);
    const email = await list.find(id);
    if (!email?.messages.includes(messageId)) return STALE;

    if (match[2] === undefined) {
      await setKeyboard(this.env, messageId, confirmKeyboard(id));
      return "Delete this email and block its sender?";
    }
    if (match[2] === "no") {
      await setKeyboard(this.env, messageId, spamKeyboard(id));
      return "Cancelled.";
    }

    if (email.sender) await list.block(email.sender);
    const blocked = email.sender
      ? `Emails from ${email.sender} are now blocked.`
      : "The email named no sender to block.";
    try {
      await callTelegram(
        this.env,
        "deleteMessages",
        JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, message_ids: email.messages })
      );
    } catch (err) {
      // Telegram only lets a bot delete messages of the last 48 hours.
      console.error("Could not delete the messages of a spam email:", err);
      await setKeyboard(this.env, messageId, { inline_keyboard: [] }).catch(() => {});
      await list.forget(id);
      return { text: `${blocked} Telegram did not let the bot delete the email; delete it by hand.`, alert: true };
    }
    await list.forget(id);
    console.log(`Marked email ${id} as spam${email.sender ? ` and blocked ${email.sender}` : ""}`);
    return `Deleted. ${blocked}`;
  }
}
