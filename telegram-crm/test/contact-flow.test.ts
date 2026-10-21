import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleContactFlow } from "../src/flows/contact";
import { findOsmNodeForOrganization } from "../src/helpers/osm";
import type { ChatId, SendMessage } from "../src/types";
import {
  addAdmin,
  chatAs,
  lastKeyboardMessage,
  resetAndStubFetch,
  sessionOf,
  telegramCalls,
  type SentMessage
} from "./harness";

const ADMIN = 5001;
let sent: SentMessage[];
beforeEach(async () => {
  sent = await resetAndStubFetch();
});
const lastText = () => sent[sent.length - 1]?.text;

// /newcontact up to "Which organization is this contact linked to?"
async function toOrganizationStep(chat: ReturnType<typeof chatAs>, name: string) {
  await chat.text("/newcontact");
  await chat.text(name);
  await chat.press("entrepreneur");
}

// ... and on to the community picker of a new organization "Cafe Satoshi"
async function toCommunityPicker(chat: ReturnType<typeof chatAs>, name: string) {
  await toOrganizationStep(chat, name);
  await chat.text("Cafe Satoshi");
  await chat.press("create_org");
  await chat.press("accepts-bitcoin");
}

// /newcontact for a consumer up to the overview card
async function toConsumerCard(chat: ReturnType<typeof chatAs>, name = "Alice") {
  await chat.text("/newcontact");
  await chat.text(name);
  await chat.press("consumer");
}

describe("audit repro: contact flow", () => {
  it("T9 never cuts the OpenStreetMap list inside an HTML tag", async () => {
    const nominatim = Array.from({ length: 8 }, (_, i) => ({
      osm_type: "node",
      osm_id: 1000 + i,
      class: "amenity",
      type: "cafe",
      display_name: "X".repeat(379)
    }));
    sent = await resetAndStubFetch({ nominatim });
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Dave");
    await chat.press("skip"); // communities
    await chat.press("card:save");
    const html = sent.find(m => m.parse_mode === "HTML")?.text ?? "";
    expect(html.split("<b>").length).toBe(html.split("</b>").length);
  });

  it("T10 shows each OpenStreetMap location once, also for communities in two regions", async () => {
    sent = await resetAndStubFetch({
      nominatim: [{ osm_type: "node", osm_id: 42, class: "amenity", type: "cafe", display_name: "Cafe Satoshi" }]
    });
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Erin");
    await chat.press("choose_other");
    await chat.press("country:0");
    const keyboard = lastKeyboardMessage(ADMIN)!.reply_markup!.inline_keyboard;
    await chat.press(keyboard[0][0].callback_data!); // e.g. Amsterdam
    await chat.press(keyboard[1][0].callback_data!); // e.g. Arnhem
    await chat.press("done");
    await chat.press("card:save");
    const osm = sent.find(m => m.parse_mode === "HTML");
    const data: string[] = JSON.parse(osm!.reply_markup!)
      .inline_keyboard.flat()
      .map((b: { callback_data: string }) => b.callback_data);
    expect(data.filter(d => d === "osmnode:node/42")).toHaveLength(1);
  });

  it("T11 recognises a +31 phone number in OpenStreetMap as a phone match", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://overpass-api.de/")) {
        return Response.json({ elements: [{ type: "node", id: 7, tags: { name: "Cafe", phone: "+31 6 12345678" } }] });
      }
      return Response.json([]);
    });
    const [result] = await findOsmNodeForOrganization({ name: "", phone: "+31612345678" });
    expect(result.matchTypes).toContain("phone");
  });

  it.each(["José García", "Jürgen Müller", "Gerbrân Hoekstra", "Dr. Anna Smit", "D’Angelo"])(
    "T12 accepts the contact name %s",
    async name => {
      await addAdmin(ADMIN);
      const chat = chatAs(ADMIN);
      await chat.text("/newcontact");
      await chat.text(name);
      expect(lastText()).toBe(`Is ${name} a consumer or an entrepreneur?`);
    }
  );

  it.each(["’t Hoekje", "Café (Leeuwarden)"])("T12b accepts the organization name %s", async name => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text(name);
    expect(lastText()).toBe(`No organization found with the name "${name}".`);
  });

  it("X4 says so when more than 5 organizations match", async () => {
    await addAdmin(ADMIN);
    for (let i = 0; i < 7; i++) {
      await env.DB.prepare("INSERT INTO organizations (name, status) VALUES (?, 2)").bind(`Cafe ${i}`).run();
    }
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("cafe");
    expect(lastText()).toMatch(/5 of 7/);
  });

  it("X5 rejects a contact npub that is not an npub", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toConsumerCard(chat);
    await chat.press("card:nostr_npub");
    await chat.text("hello");
    expect(lastText()).toBe("❌ Please enter a valid nostr npub (npub1…).");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card_field" });
    expect(sessionOf(ADMIN)?.nostr_npub).toBeUndefined();
  });

  it("T13 answers when a contact session has an unknown step", async () => {
    const messages: string[] = [];
    const send = (async (_env: Env, _chatId: ChatId, text: string) => {
      messages.push(text);
    }) as unknown as SendMessage;
    let removed = false;
    await handleContactFlow(
      send,
      {} as Env,
      1,
      "hello",
      { mode: "contact", step: "awaiting_renamed_step" },
      async () => {},
      async () => {
        removed = true;
      }
    );
    expect({ messages: messages.length, removed }).toEqual({ messages: 1, removed: true });
  });
});

describe("contact flow input checks", () => {
  const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

  it.each(["12345", "an@example.com", "A", "R2-D2"])("still refuses the contact name %s", async name => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text(name);
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_name" });
  });

  it.each(["+31 6 12345678", "info@cafe.nl", "!!!"])("still refuses the organization name %s", async name => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text(name);
    expect(lastText()).toMatch(/^❌ Please enter a valid organization name/);
  });

  it("accepts a two-letter name", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Bo");
    expect(lastText()).toBe("Is Bo a consumer or an entrepreneur?");
  });

  it("accepts a real npub, and Back and Remove on a detail", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toConsumerCard(chat);
    await chat.press("card:nostr_npub");
    await chat.text(NPUB);
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card", nostr_npub: NPUB });
    expect(lastText()).toContain(`🟣 Nostr: ${NPUB}`);
    await chat.press("card:nostr_npub");
    await chat.press("card:remove");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card", nostr_npub: null });
    await chat.press("card:email");
    await chat.press("card:back");
    expect(lastText()).toContain("📧 Email: —");
  });

  it("checks the organization website and npub on the card", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Bob");
    await chat.press("skip");
    await chat.press("card:organization_website");
    await chat.text("hello");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card_field" });
    await chat.text("cafesatoshi.nl");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card", organization_website: "cafesatoshi.nl" });
    await chat.press("card:organization_nostr_npub");
    await chat.text("hello");
    expect(lastText()).toBe("❌ Please enter a valid nostr npub (npub1…).");
  });

  it("lists every OpenStreetMap place within one message, with a button each", async () => {
    const nominatim = Array.from({ length: 8 }, (_, i) => ({
      osm_type: "node",
      osm_id: 1000 + i,
      class: "amenity",
      type: "cafe",
      display_name: "X".repeat(379)
    }));
    sent = await resetAndStubFetch({ nominatim });
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Dave");
    await chat.press("skip");
    await chat.press("card:save");
    const osm = sent.find(m => m.parse_mode === "HTML")!;
    expect(osm.text.length).toBeLessThan(4096);
    // Without "Search another name", "None of these" and Cancel.
    const buttons = JSON.parse(osm.reply_markup!).inline_keyboard.slice(0, -3);
    expect(buttons).toHaveLength(8);
    expect(buttons[0][0].text).toBe(`1. ${"X".repeat(59)}…`);
    expect(sessionOf(ADMIN)?.osm_options).toHaveLength(8);
  });
});

describe("phone numbers", () => {
  it.each([
    ["06 12345678", "+31612345678"],
    ["+31 (0)6-1234 5678", "+31612345678"],
    ["0032 470 12 34 56", "+32470123456"]
  ])("stores %s as %s, in international form", async (input, stored) => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toConsumerCard(chat);
    await chat.press("card:phone");
    await chat.text(input);
    expect(lastText()).toContain(`📞 Phone: ${stored}`);
    await chat.press("card:save");
    expect(await env.DB.prepare("SELECT phone FROM contact_phones").first()).toEqual({ phone: stored });
  });

  it("gives a national number +32 when the member's communities are all Belgian", async () => {
    const adminId = await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 19)")
      .bind(adminId)
      .run();
    const chat = chatAs(ADMIN);
    await toConsumerCard(chat);
    await chat.press("card:phone");
    await chat.text("0470 12 34 56");
    expect(sessionOf(ADMIN)).toMatchObject({ phone: "+32470123456" });
  });

  it("refuses what is no phone number", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toConsumerCard(chat);
    await chat.press("card:phone");
    await chat.text("12");
    expect(lastText()).toBe("❌ Please enter a valid phone number, for example 06 12345678.");
  });

  it("are searched in OpenStreetMap in international form", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Bob");
    await chat.press("skip");
    await chat.press("card:phone");
    await chat.text("06 12345678");
    await chat.press("card:save");
    const [overpass] = telegramCalls("overpass");
    expect(String(overpass.body.data)).toContain(String.raw`(\\+|00)31.*6.*1.*2.*3.*4.*5.*6.*7.*8`);
  });
});

describe("the overview card", () => {
  it("lets a consumer be saved with a name, a type and Save", async () => {
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.press("consumer");
    expect(lastText()).toBe(
      [
        "New contact:",
        "👤 Alice",
        "🏷️ Consumer",
        "",
        "📧 Email: —",
        "📞 Phone: —",
        "🟣 Nostr: —",
        "",
        "Tap a detail to add it, or Save."
      ].join("\n")
    );
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Contact "Alice" added.');
    expect(await env.DB.prepare("SELECT name, type FROM contacts").first()).toEqual({
      name: "Alice",
      type: "consumer"
    });
    expect(await env.DB.prepare("SELECT performed_by FROM audit_log WHERE table_name = 'contacts'").first()).toEqual({
      performed_by: adminId
    });
  });

  it("warns about contacts with a similar name", async () => {
    await addAdmin(ADMIN);
    const alice = await env.DB.prepare(
      "INSERT INTO contacts (name, type) VALUES ('Alice Jansen', 'consumer') RETURNING id"
    ).first<number>("id");
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    expect(lastText()).toMatch(/^⚠️ There are contacts with a similar name\./);
    const keyboard = lastKeyboardMessage(ADMIN)!.reply_markup!.inline_keyboard;
    expect(keyboard.slice(0, 2)).toEqual([
      [{ text: "💬 Alice Jansen", callback_data: `log:${alice}` }],
      [{ text: '➕ Add "Alice" as a new contact', callback_data: "new_contact" }]
    ]);
    await chat.press("new_contact");
    expect(lastText()).toBe("Is Alice a consumer or an entrepreneur?");
  });

  it("takes the name and phone number of a shared Telegram contact", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.shareContact({ phone_number: "31612345678", first_name: "Anna", last_name: "de Vries" });
    expect(lastText()).toBe("Is Anna de Vries a consumer or an entrepreneur?");
    await chat.press("consumer");
    expect(lastText()).toContain("📞 Phone: +31612345678");
  });

  it("lists organizations of the member's own community first, with their place", async () => {
    const adminId = await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 6)")
      .bind(adminId)
      .run();
    for (const [name, community] of [
      ["Cafe Amsterdam", 1],
      ["Cafe Leeuwarden", 6]
    ] as const) {
      const id = await env.DB.prepare("INSERT INTO organizations (name, status) VALUES (?, 2) RETURNING id")
        .bind(name)
        .first<number>("id");
      await env.DB.prepare("INSERT INTO organization_communities (organization_id, community_id) VALUES (?, ?)")
        .bind(id, community)
        .run();
    }
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("cafe");
    expect(
      lastKeyboardMessage(ADMIN)!
        .reply_markup!.inline_keyboard.slice(0, 2)
        .map(row => row[0].text)
    ).toEqual(["Cafe Leeuwarden · Friesland", "Cafe Amsterdam · Amsterdam"]);
  });

  it("starts the organization's communities with the member's own selected", async () => {
    const adminId = await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, 6)")
      .bind(adminId)
      .run();
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Bob");
    expect(lastKeyboardMessage(ADMIN)!.reply_markup!.inline_keyboard[0][0].text).toBe("✅ Bitcoin Friesland");
    await chat.press("done");
    expect(lastText()).toContain("🏢 Cafe Satoshi (new: Accepts Bitcoin; Bitcoin Friesland)");
  });

  it("can search OpenStreetMap for another name", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toCommunityPicker(chat, "Bob");
    await chat.press("skip");
    sent.length = 0;
    // The first search finds nothing, so it saves right away; start a search by hand instead.
    sent = await resetAndStubFetch({
      nominatim: [
        {
          osm_type: "node",
          osm_id: 42,
          class: "amenity",
          type: "cafe",
          display_name: "Satoshi, Leeuwarden",
          extratags: { amenity: "cafe" }
        }
      ]
    });
    await addAdmin(ADMIN);
    await toCommunityPicker(chat, "Bob");
    await chat.press("skip");
    await chat.press("card:save");
    await chat.press("osm:search");
    expect(lastText()).toBe("Which name should I search OpenStreetMap for?");
    await chat.text("Satoshi");
    expect(lastText()).toMatch(/^Which place on OpenStreetMap is "Satoshi"\?/);
    await chat.press("osmnode:node/42");
    expect(lastText()).toBe('✅ Organization "Cafe Satoshi" and contact "Bob" added. (📍 location linked)');
  });
});
