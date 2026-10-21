import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleContactFlow } from "../src/flows/contact";
import { findOsmNodeForOrganization } from "../src/helpers/osm";
import type { ChatId, SendMessage } from "../src/types";
import { addAdmin, chatAs, lastKeyboardMessage, resetAndStubFetch, sessionOf, type SentMessage } from "./harness";

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
  await chat.press("skip");
  await chat.press("skip");
  await chat.press("skip");
  await chat.press("entrepreneur");
}

// ... and on to the community picker of a new organization "Cafe Satoshi"
async function toCommunityPicker(chat: ReturnType<typeof chatAs>, name: string) {
  await toOrganizationStep(chat, name);
  await chat.text("Cafe Satoshi");
  await chat.press("create_org");
  await chat.press("accepts-bitcoin");
  await chat.press("skip"); // website
  await chat.press("skip"); // npub
}

describe("audit repro: contact flow", () => {
  it("T9 never cuts the OpenStreetMap list inside an HTML tag", async () => {
    // 8 results of 438 characters each: the 3500-character cut lands inside "<b>OSM type:</b>" of the last one.
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
      expect(lastText()).toBe("What is the email address of the contact? (optional)");
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
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.press("skip");
    await chat.press("skip");
    await chat.text("hello");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_nostr" });
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

  it.each(["12345", "an@example.com", "Al", "R2-D2"])("still refuses the contact name %s", async name => {
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

  it("accepts a real npub and still lets Skip through", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/newcontact");
    await chat.text("Alice");
    await chat.press("skip");
    await chat.press("skip");
    await chat.text(NPUB);
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_type", nostr_npub: NPUB });
  });

  it("checks the organization website and npub, and keeps Skip working", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await toOrganizationStep(chat, "Bob");
    await chat.text("Cafe Satoshi");
    await chat.press("create_org");
    await chat.press("accepts-bitcoin");
    await chat.text("hello");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_org_website" });
    await chat.text("cafesatoshi.nl");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_org_nostr", organization_website: "cafesatoshi.nl" });
    await chat.text("hello");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_org_nostr" });
    await chat.press("skip");
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_communities", organization_nostr_npub: null });
  });

  it("lists only whole OpenStreetMap items and offers buttons for exactly those", async () => {
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
    const osm = sent.find(m => m.parse_mode === "HTML")!;
    const shown = osm.text.split("<b># ").length - 1;
    // Without "None of the above" and Cancel.
    const buttons = JSON.parse(osm.reply_markup!).inline_keyboard.length - 2;
    expect({ shown, buttons, note: osm.text.includes(`Showing ${shown} of 8 locations.`) }).toEqual({
      shown: 7,
      buttons: 7,
      note: true
    });
    expect(sessionOf(ADMIN)?.osm_options).toHaveLength(7);
  });
});
