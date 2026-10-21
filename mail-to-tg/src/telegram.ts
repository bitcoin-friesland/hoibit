const MAX_RETRY_WAIT_SECONDS = 30;

// Telegram HTML parse mode: only <, > and & in text need escaping.
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

// Calls the Bot API and throws unless Telegram confirms with ok: true. Waits out 429s
// (up to MAX_RETRY_WAIT_SECONDS in total) and retries a 5xx or network error once.
async function callTelegram(env: Env, method: string, body: string | FormData) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
  const init: RequestInit = { method: "POST", body };
  if (typeof body === "string") init.headers = { "Content-Type": "application/json" };

  let waited = 0;
  let retried = false;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      if (retried) throw new Error(`Telegram ${method} failed: ${err}`, { cause: err });
      console.warn(`Telegram ${method} network error, retrying once:`, err);
      retried = true;
      await sleep(1000);
      continue;
    }

    const data = (await resp.json().catch(() => ({}))) as TelegramResponse;
    if (resp.ok && data.ok) return;

    const reason = `${resp.status} ${data.description ?? resp.statusText}`;
    if (resp.status === 429) {
      const wait = Math.max(1, data.parameters?.retry_after ?? 1);
      if (waited + wait <= MAX_RETRY_WAIT_SECONDS) {
        console.warn(`Telegram ${method} rate limited, retrying after ${wait}s`);
        waited += wait;
        await sleep(wait * 1000);
        continue;
      }
    } else if (resp.status >= 500 && !retried) {
      console.warn(`Telegram ${method} failed with ${reason}, retrying once`);
      retried = true;
      await sleep(1000);
      continue;
    }
    throw new Error(`Telegram ${method} failed: ${reason}`);
  }
}

async function sendMessage(env: Env, text: string, first?: boolean) {
  const html = escapeHtml(text);
  await callTelegram(
    env,
    "sendMessage",
    JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: first ? html.replace("📩 New Email", "📩 <b>New Email</b>") : html,
      parse_mode: "HTML"
    })
  );
}

async function sendDocument(env: Env, text: string) {
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("document", new File([text], "email.txt", { type: "text/plain;charset=utf-8" }));
  await callTelegram(env, "sendDocument", form);
}

// One Bot API call that carries (part of) an email; plain data, so the outbox can store it.
export type Send = { kind: "message"; text: string; first?: boolean } | { kind: "document"; text: string };

export async function deliver(env: Env, send: Send) {
  if (send.kind === "document") await sendDocument(env, send.text);
  else await sendMessage(env, send.text, send.first);
}
