import PostalMime from "postal-mime";

export default {
  async email(message, env, ctx) {
    const parser = new PostalMime();
    const parsed = await parser.parse(message.raw);

    const from = parsed.from?.name
      ? `${parsed.from.name} <${parsed.from.address}>`
      : parsed.from?.address || "(unknown)";

    const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
    const to = toList
      .filter(Boolean)
      .map(t => t?.name ? `${t.name} <${t.address}>` : t?.address || "(unknown)")
      .join(", ");

    const ccList = Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc];
    const cc = ccList
      .filter(Boolean)
      .map(c => c?.name ? `${c.name} <${c.address}>` : c?.address || "(unknown)")
      .join(", ");

    const subject = parsed.subject || "(No subject)";
    const text = parsed.text?.substring(0, 1000) || "(No content)";

    let messageBody = `📩 *New Email*\n👤 From: ${from}\n📬 To: ${to}`;
    if (cc) {
      messageBody += `\n🟡 CC: ${cc}`;
    }
    messageBody += `\n📝 Subject: ${subject}\n\n${text}`;

    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: messageBody,
            parse_mode: "Markdown",
          }),
        }
      );

      const body = await resp.text();
      console.log("Telegram response status:", resp.status);
      console.log("Telegram response body:", body);
    } catch (err) {
      console.error("Failed to send to Telegram:", err);
    }
  },

  async fetch(request, env, ctx) {
    return new Response(
      "403 Forbidden: This worker only accepts email traffic via Cloudflare Email Routing.",
      {
        status: 403,
        headers: {
          "Content-Type": "text/plain",
          "X-Robots-Tag": "noindex, nofollow"
        }
      }
    );
  },
};
