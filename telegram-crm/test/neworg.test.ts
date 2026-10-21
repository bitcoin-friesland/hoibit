import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { addAdmin, chatAs, lastKeyboardMessage, resetAndStubFetch, sessionOf, type SentMessage } from "./harness";

const ADMIN = 5001;
const NPUB = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
const CAFE_IN_OSM = {
  osm_type: "node",
  osm_id: 42,
  class: "amenity",
  type: "cafe",
  display_name: "Cafe Satoshi, Leeuwarden",
  address: { road: "Nieuwestad", city: "Leeuwarden" }
};

let sent: SentMessage[];
beforeEach(async () => {
  sent = await resetAndStubFetch();
});
const lastText = () => sent[sent.length - 1]?.text;
// The buttons of the newest message that still has them, without the Cancel row every flow gets.
const lastKeyboard = () =>
  lastKeyboardMessage(ADMIN)!.reply_markup!.inline_keyboard.filter(row => row[0].callback_data !== "cancel");

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

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())?.n;

describe("audit repro: /neworg and the new organization of /newcontact", () => {
  it("T15 /neworg, which /help lists, creates an organization", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/help");
    expect(lastText()).toContain("/neworg - Add an organization");
    await chat.text("/neworg");
    await chat.text("Cafe Satoshi");
    expect(lastText()).not.toBe("Organization flow not implemented in this build.");
  });

  it("X6 keeps no new organization when saving its contact fails", async () => {
    await addAdmin(ADMIN);
    const spy = vi.spyOn(CrmApi.prototype, "newContact").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      const chat = chatAs(ADMIN);
      await toCommunityPicker(chat, "Bob");
      await chat.press("skip"); // communities
      await chat.press("card:save"); // no OpenStreetMap results, so it saves right away
      const orgs = await env.DB.prepare("SELECT COUNT(*) AS n FROM organizations").first();
      expect(orgs).toEqual({ n: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("/neworg", () => {
  it("saves an organization with status, website, npub, community and OpenStreetMap location, with audit", async () => {
    sent = await resetAndStubFetch({ nominatim: [CAFE_IN_OSM] });
    const adminId = await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/neworg");
    expect(lastText()).toBe("What is the name of the organization?");
    await chat.text("Cafe Satoshi");
    expect(lastText()).toBe('What is the Bitcoin status of "Cafe Satoshi"?');
    expect(lastKeyboard().map(row => row[0].text)).toEqual([
      "Curious about Bitcoin",
      "Accepts Bitcoin",
      "Not Interested",
      "Stopped Accepting Bitcoin"
    ]);
    await chat.press("accepts-bitcoin");
    expect(lastText()).toBe("Select Bitcoin communities for this organization:");
    expect(lastKeyboard().at(-1)).toEqual([{ text: "No community", callback_data: "skip" }]);
    await chat.press("choose_other");
    await chat.press("country:0");
    const community = lastKeyboard()[0][0];
    await chat.press(community.callback_data!);
    await chat.press("done");
    expect(lastText()).toBe(
      [
        "New organization:",
        "🏢 Cafe Satoshi",
        "🏷️ Accepts Bitcoin",
        `👥 ${community.text}`,
        "",
        "🌐 Website: —",
        "🟣 Nostr: —",
        "",
        "Tap a detail to add it, or Save."
      ].join("\n")
    );
    await chat.press("card:organization_website");
    expect(lastText()).toBe("What is the website of the organization? For example example.com.");
    await chat.text("https://cafe.example");
    await chat.press("card:organization_nostr_npub");
    await chat.text(NPUB);
    expect(lastText()).toContain(`🌐 Website: https://cafe.example\n🟣 Nostr: ${NPUB}`);
    await chat.press("card:save");
    const choice = sent[sent.length - 1];
    expect(choice.parse_mode).toBe("HTML");
    expect(choice.text).toBe(
      'Which place on OpenStreetMap is "Cafe Satoshi"?\n\n<b>1. Cafe Satoshi</b>\ncafe · Nieuwestad, Leeuwarden\n<a href="https://www.openstreetmap.org/node/42">View on the map</a>'
    );
    expect(lastKeyboard()[0]).toEqual([
      { text: "1. Cafe Satoshi – Nieuwestad, Leeuwarden", callback_data: "osmnode:node/42" }
    ]);
    await chat.press("osmnode:node/42");
    expect(lastText()).toBe(
      `✅ Organization "Cafe Satoshi" added. (communities: ${community.text}; 📍 location linked)`
    );
    expect(sessionOf(ADMIN)).toBeUndefined();

    const org = await env.DB.prepare(
      `SELECT o.id, o.name, o.status, o.website, o.nostr_npub, o.location_osm_id,
              (SELECT COUNT(*) FROM organization_communities oc WHERE oc.organization_id = o.id) AS communities
       FROM organizations o`
    ).first<{ id: number }>();
    expect(org).toEqual({
      id: expect.any(Number),
      name: "Cafe Satoshi",
      status: 2,
      website: "https://cafe.example",
      nostr_npub: NPUB,
      location_osm_id: "node/42",
      communities: 1
    });
    const audit = await env.DB.prepare(
      "SELECT action, record_id, performed_by FROM audit_log WHERE table_name = 'organizations'"
    ).all();
    expect(audit.results).toEqual([{ action: "insert", record_id: String(org!.id), performed_by: adminId }]);
    expect(await count("contacts")).toBe(0);
  });

  it("saves right away without communities or OpenStreetMap results", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/neworg");
    await chat.text("’t Hoekje");
    await chat.press("btc-curious");
    await chat.press("skip"); // communities
    await chat.press("card:save");
    expect(lastText()).toBe('✅ Organization "’t Hoekje" added.\nNo OpenStreetMap location was found.');
    expect(await env.DB.prepare("SELECT name, status, website, nostr_npub FROM organizations").first()).toEqual({
      name: "’t Hoekje",
      status: 1,
      website: null,
      nostr_npub: null
    });
  });

  it("warns about an existing organization with the same name and creates only on request", async () => {
    await addAdmin(ADMIN);
    await env.DB.prepare("INSERT INTO organizations (name, status) VALUES ('Cafe Satoshi', 2)").run();
    const chat = chatAs(ADMIN);
    await chat.text("/neworg");
    await chat.text("Cafe Satoshi");
    expect(lastText()).toContain("Cafe Satoshi");
    expect(lastText()).toMatch(/already/);
    expect(lastKeyboard()).toEqual([
      [{ text: 'Create new "Cafe Satoshi"', callback_data: "create_org" }],
      [{ text: "Search again", callback_data: "search_org_again" }]
    ]);
    expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_org_name" });

    await chat.press("search_org_again");
    expect(lastText()).toBe("What is the name of the organization?");
    await chat.text("Cafe Satoshi");
    await chat.press("create_org");
    expect(lastText()).toBe('What is the Bitcoin status of "Cafe Satoshi"?');
    await chat.press("accepts-bitcoin");
    await chat.press("skip");
    await chat.press("card:save");
    expect(lastText()).toMatch(/^✅ Organization "Cafe Satoshi" added\./);
    expect(await count("organizations")).toBe(2);
  });

  it.each(["+31 6 12345678", "info@cafe.nl", "!!!"])("refuses the organization name %s", async name => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/neworg");
    await chat.text(name);
    expect(lastText()).toMatch(/^❌ Please enter a valid organization name/);
    expect(sessionOf(ADMIN)).toMatchObject({ mode: "org", step: "awaiting_org_name" });
  });

  it("keeps the input after a refused save, so Save can be tapped again", async () => {
    await addAdmin(ADMIN);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(CrmApi.prototype, "newOrg").mockResolvedValue({ ok: false, status: 400, error: "Bad" });
    const chat = chatAs(ADMIN);
    try {
      await chat.text("/neworg");
      await chat.text("Cafe Satoshi");
      await chat.press("accepts-bitcoin");
      await chat.press("skip");
      await chat.press("card:save");
      expect(lastText()).toBe("❌ Saving failed, nothing was saved. Please try again.");
      expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card", organization: "Cafe Satoshi" });
      expect(await count("organizations")).toBe(0);
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
    await chat.press("card:save");
    expect(lastText()).toMatch(/^✅ Organization "Cafe Satoshi" added\./);
    expect(await count("organizations")).toBe(1);
  });
});

describe("/newcontact with a new organization", () => {
  it("saves organization, communities, contact and both audit entries with one call", async () => {
    const adminId = await addAdmin(ADMIN);
    const newOrg = vi.spyOn(CrmApi.prototype, "newOrg");
    try {
      const chat = chatAs(ADMIN);
      await toCommunityPicker(chat, "Bob");
      await chat.press("skip");
      await chat.press("card:save");
      expect(lastText()).toBe(
        '✅ Organization "Cafe Satoshi" and contact "Bob" added.\nNo OpenStreetMap location was found.'
      );
      expect(newOrg).not.toHaveBeenCalled();
    } finally {
      newOrg.mockRestore();
    }
    const row = await env.DB.prepare(
      "SELECT o.name AS organization, c.name AS contact FROM contacts c JOIN organizations o ON o.id = c.organization_id"
    ).first();
    expect(row).toEqual({ organization: "Cafe Satoshi", contact: "Bob" });
    const audit = await env.DB.prepare(
      "SELECT table_name, performed_by FROM audit_log WHERE table_name IN ('contacts', 'organizations') ORDER BY table_name"
    ).all();
    expect(audit.results).toEqual([
      { table_name: "contacts", performed_by: adminId },
      { table_name: "organizations", performed_by: adminId }
    ]);
  });

  it("tells the user nothing was saved when the save fails, without technical details", async () => {
    await addAdmin(ADMIN);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(CrmApi.prototype, "newContact").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      const chat = chatAs(ADMIN);
      await toCommunityPicker(chat, "Bob");
      await chat.press("skip");
      await chat.press("card:save");
      expect(lastText()).toBe("❌ Saving failed, nothing was saved. Please try again.");
      expect(sessionOf(ADMIN)).toMatchObject({ step: "awaiting_card" });
      expect(await count("contacts")).toBe(0);
    } finally {
      spy.mockRestore();
      error.mockRestore();
    }
  });
});
