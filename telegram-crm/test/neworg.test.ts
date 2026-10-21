import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CrmApi from "../../crm-api/src/index";
import { addAdmin, chatAs, resetAndStubFetch, sessionOf, type SentMessage } from "./harness";

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
const lastKeyboard = (): { text: string; callback_data: string }[][] =>
  JSON.parse(sent[sent.length - 1].reply_markup!).inline_keyboard;

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

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())?.n;

describe("audit repro: /neworg and the new organization of /newcontact", () => {
  it("T15 /neworg, which /help lists, creates an organization", async () => {
    await addAdmin(ADMIN);
    const chat = chatAs(ADMIN);
    await chat.text("/help");
    expect(lastText()).toContain("/neworg - Add new organization");
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
      await chat.press("skip"); // communities; no OpenStreetMap results, so it saves right away
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
    expect(lastText()).toBe("What is the Bitcoin adoption status of the organization?");
    await chat.press("accepts-bitcoin");
    expect(lastText()).toBe("What is the website of the organization? (optional)");
    await chat.text("https://cafe.example");
    expect(lastText()).toBe("What is the nostr npub of the organization? (optional)");
    await chat.text(NPUB);
    expect(lastText()).toBe("Select Bitcoin communities for this organization:");
    await chat.press("choose_other");
    await chat.press("country:0");
    const community = lastKeyboard()[0][0];
    await chat.press(community.callback_data);
    await chat.press("done");
    const choice = sent[sent.length - 1];
    expect(choice.parse_mode).toBe("HTML");
    expect(choice.text).toContain("<b>Address:</b> Nieuwestad, Leeuwarden");
    await chat.press("osmnode:node/42");
    expect(lastText()).toBe(
      `✅ Organization "Cafe Satoshi" added. (communities: ${community.text}; OpenStreetMap: node/42)`
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
    await chat.press("skip");
    await chat.press("skip");
    await chat.press("skip"); // communities
    expect(lastText()).toBe('✅ Organization "’t Hoekje" added.');
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
    expect(lastText()).toBe("What is the Bitcoin adoption status of the organization?");
    await chat.press("accepts-bitcoin");
    await chat.press("skip");
    await chat.press("skip");
    await chat.press("skip");
    expect(lastText()).toBe('✅ Organization "Cafe Satoshi" added.');
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

  it("reports a refused save and keeps nothing", async () => {
    await addAdmin(ADMIN);
    const spy = vi.spyOn(CrmApi.prototype, "newOrg").mockResolvedValue({ ok: false, status: 400, error: "Bad" });
    try {
      const chat = chatAs(ADMIN);
      await chat.text("/neworg");
      await chat.text("Cafe Satoshi");
      await chat.press("accepts-bitcoin");
      await chat.press("skip");
      await chat.press("skip");
      await chat.press("skip");
      expect(lastText()).toBe("❌ Failed to add organization (code 400).");
      expect(sessionOf(ADMIN)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
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
      expect(lastText()).toBe('✅ Organization "Cafe Satoshi" and contact "Bob" added.');
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

  it("tells the user nothing was saved when the save fails", async () => {
    await addAdmin(ADMIN);
    const spy = vi.spyOn(CrmApi.prototype, "newContact").mockRejectedValue(new Error("D1_ERROR: unavailable"));
    try {
      const chat = chatAs(ADMIN);
      await toCommunityPicker(chat, "Bob");
      await chat.press("skip");
      expect(lastText()).toMatch(/^❌ .*Nothing was saved\.$/);
      expect(sessionOf(ADMIN)).toBeUndefined();
      expect(await count("contacts")).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
