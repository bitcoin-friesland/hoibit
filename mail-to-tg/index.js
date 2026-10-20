import PostalMime from "postal-mime";

// Telegram HTML parse mode: only <, > and & in text need escaping.
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
      .map(t => (t?.name ? `${t.name} <${t.address}>` : t?.address || "(unknown)"))
      .join(", ");

    const ccList = Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc];
    const cc = ccList
      .filter(Boolean)
      .map(c => (c?.name ? `${c.name} <${c.address}>` : c?.address || "(unknown)"))
      .join(", ");

    const subject = parsed.subject || "(No subject)";
    const text = parsed.text || "(No content)";

    // Build the header for the first message (plain text; escaped per message when sending)
    let header = `📩 New Email\n👤 From: ${from}\n📬 To: ${to}`;
    if (cc) {
      header += `\n🟡 CC: ${cc}`;
    }
    header += `\n📝 Subject: ${subject}\n\n`;

    // Telegram message limit is 4096 characters
    const MAX_MESSAGE_LENGTH = 4096;

    // Split the text into chunks if needed
    const messages = [];

    // Calculate how much space we have for the email content in the first message
    const firstMessageContentSpace = MAX_MESSAGE_LENGTH - header.length;

    if (text.length <= firstMessageContentSpace) {
      // Email fits in one message
      messages.push(header + text);
    } else {
      // Email needs to be split into multiple messages
      // First message with header
      messages.push(header + text.substring(0, firstMessageContentSpace));

      // Subsequent messages without any markers for smooth reading
      let remaining = text.substring(firstMessageContentSpace);

      while (remaining.length > 0) {
        if (remaining.length <= MAX_MESSAGE_LENGTH) {
          // Last chunk
          messages.push(remaining);
          remaining = "";
        } else {
          // More chunks to follow
          messages.push(remaining.substring(0, MAX_MESSAGE_LENGTH));
          remaining = remaining.substring(MAX_MESSAGE_LENGTH);
        }
      }
    }

    // Send all message parts. Escaping happens after splitting, so no entity is cut in half;
    // Telegram's 4096 limit counts characters after entity parsing.
    try {
      for (let i = 0; i < messages.length; i++) {
        const html = escapeHtml(messages[i]);
        const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: i === 0 ? html.replace("📩 New Email", "📩 <b>New Email</b>") : html,
            parse_mode: "HTML"
          })
        });

        const body = await resp.text();
        console.log(`Telegram response status (part ${i + 1}/${messages.length}):`, resp.status);
        console.log(`Telegram response body (part ${i + 1}/${messages.length}):`, body);

        // Small delay between messages to avoid rate limiting
        if (i < messages.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (err) {
      console.error("Failed to send to Telegram:", err);
    }
  },

  async fetch(request, env, ctx) {
    return new Response("403 Forbidden: This worker only accepts email traffic via Cloudflare Email Routing.", {
      status: 403,
      headers: {
        "Content-Type": "text/plain",
        "X-Robots-Tag": "noindex, nofollow"
      }
    });
  }
};
