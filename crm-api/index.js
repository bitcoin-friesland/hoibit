// index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/validate-user") {
      const { telegram_id } = await request.json();
      if (!telegram_id) {
        return new Response("Missing telegram_id", { status: 400 });
      }
      try {
        const query = `SELECT * FROM team_members WHERE telegram_id = ?`;
        const result = await env.DB.prepare(query).bind(parseInt(telegram_id, 10)).all();
        const user = result.results && result.results[0];
        if (!user) {
          return new Response("User not found", { status: 404 });
        }
        return new Response(JSON.stringify(user), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error while validating user:", error);
        return new Response("Internal server error", { status: 500 });
      }
    }
    if (request.method === "PATCH" && url.pathname === "/team_member") {
      const data = await request.json();
      if (!data.team_member_id) {
        return new Response("Missing team_member_id", { status: 400 });
      }
      try {
        const oldMember = await env.DB.prepare(
          `SELECT name, time_zone FROM team_members WHERE id = ?`
        ).bind(parseInt(data.team_member_id, 10)).first();
        let changedFields = {};
        if (data.name || data.time_zone) {
          let setParts = [];
          let params = [];
          if (data.name) {
            setParts.push("name = ?");
            params.push(data.name);
            if (oldMember && oldMember.name !== data.name) {
              changedFields.name = { old: oldMember.name, new: data.name };
            }
          }
          if (data.time_zone) {
            setParts.push("time_zone = ?");
            params.push(data.time_zone);
            if (oldMember && oldMember.time_zone !== data.time_zone) {
              changedFields.time_zone = { old: oldMember.time_zone, new: data.time_zone };
            }
          }
          params.push(parseInt(data.team_member_id, 10));
          await env.DB.prepare(
            `UPDATE team_members SET ${setParts.join(", ")} WHERE id = ?`
          ).bind(...params).run();
        }
        if (Array.isArray(data.community_ids)) {
          await env.DB.prepare(
            `DELETE FROM team_member_communities WHERE team_member_id = ?`
          ).bind(parseInt(data.team_member_id, 10)).run();
          for (const community_id of data.community_ids) {
            await env.DB.prepare(
              `INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`
            ).bind(parseInt(data.team_member_id, 10), parseInt(community_id, 10)).run();
          }
          changedFields.community_ids = { old: "replaced", new: data.community_ids };
        }
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "update",
          "team_members",
          parseInt(data.team_member_id, 10),
          data.updated_by ? parseInt(data.updated_by, 10) : null,
          Object.keys(changedFields).length > 0 ? JSON.stringify({ fields: changedFields }) : null
        ).run();
        return new Response("Team member updated", { status: 200 });
      } catch (error) {
        console.error("Error updating team member:", error);
        return new Response("Failed to update team member", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/team_member") {
      const data = await request.json();
      if (!data.telegram_id || !data.name) {
        return new Response("Missing telegram_id or name", { status: 400 });
      }
      try {
        const existing = await env.DB.prepare(
          `SELECT id FROM team_members WHERE telegram_id = ?`
        ).bind(parseInt(data.telegram_id, 10)).first();
        if (existing) {
          if (Array.isArray(data.community_ids) && data.community_ids.length > 0) {
            for (const community_id of data.community_ids) {
              await env.DB.prepare(
                `INSERT OR IGNORE INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`
              ).bind(parseInt(existing.id, 10), parseInt(community_id, 10)).run();
            }
          }
          if (data.time_zone) {
            await env.DB.prepare(
              `UPDATE team_members SET time_zone = ? WHERE id = ?`
            ).bind(data.time_zone, parseInt(existing.id, 10)).run();
          }
          return Response.json({ id: existing.id, existing: true });
        }
        const insertQuery = data.time_zone ? `INSERT INTO team_members (telegram_id, name, time_zone) VALUES (?, ?, ?)` : `INSERT INTO team_members (telegram_id, name) VALUES (?, ?)`;
        const insertParams = data.time_zone ? [parseInt(data.telegram_id, 10), data.name, data.time_zone] : [parseInt(data.telegram_id, 10), data.name];
        const res = await env.DB.prepare(insertQuery).bind(...insertParams).run();
        const newMember = await env.DB.prepare(
          `SELECT id FROM team_members WHERE telegram_id = ?`
        ).bind(parseInt(data.telegram_id, 10)).first();
        if (newMember && Array.isArray(data.community_ids) && data.community_ids.length > 0) {
          for (const community_id of data.community_ids) {
            await env.DB.prepare(
              `INSERT INTO team_member_communities (team_member_id, community_id) VALUES (?, ?)`
            ).bind(parseInt(newMember.id, 10), parseInt(community_id, 10)).run();
          }
        }
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "insert",
          "team_members",
          parseInt(newMember.id, 10),
          data.invited_by ? parseInt(data.invited_by, 10) : null,
          JSON.stringify({
            fields: {
              telegram_id: { old: null, new: data.telegram_id },
              name: { old: null, new: data.name },
              ...data.time_zone ? { time_zone: { old: null, new: data.time_zone } } : {}
            }
          })
        ).run();
        return Response.json({ id: newMember.id, created: true });
      } catch (error) {
        console.error("Error saving team member:", error);
        return new Response("Failed to add team member", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/newcontact") {
      const data = await request.json();
      try {
        if (!data.name || !data.type) {
          return new Response("Missing required fields: name or type", { status: 400 });
        }
        let insertContactQuery, contactParams;
        if (data.community_id) {
          insertContactQuery = `INSERT INTO contacts (name, type, organization_id, community_id) VALUES (?, ?, ?, ?)`;
          contactParams = [
            data.name,
            data.type,
            data.organization_id ? parseInt(data.organization_id, 10) : null,
            parseInt(data.community_id, 10)
          ];
        } else {
          insertContactQuery = `INSERT INTO contacts (name, type, organization_id) VALUES (?, ?, ?)`;
          contactParams = [
            data.name,
            data.type,
            data.organization_id ? parseInt(data.organization_id, 10) : null
          ];
        }
        const contactRes = await env.DB.prepare(insertContactQuery).bind(...contactParams).run();
        if (!contactRes || !contactRes.lastInsertRowid) {
          console.error("Insert contact failed, no lastInsertRowid returned");
          return new Response("Failed to add contact", { status: 500 });
        }
        const contactId = contactRes.lastInsertRowid;
        if (data.email) {
          const insertEmailQuery = `INSERT INTO contact_emails (contact_id, email) VALUES (?, ?)`;
          await env.DB.prepare(insertEmailQuery).bind(
            parseInt(contactId, 10),
            data.email
          ).run();
        }
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "insert",
          "contacts",
          parseInt(contactId, 10),
          data.created_by ? parseInt(data.created_by, 10) : null,
          JSON.stringify({
            fields: {
              name: { old: null, new: data.name },
              type: { old: null, new: data.type },
              organization_id: { old: null, new: data.organization_id ? parseInt(data.organization_id, 10) : null },
              ...data.community_id ? { community_id: { old: null, new: parseInt(data.community_id, 10) } } : {},
              ...data.email ? { email: { old: null, new: data.email } } : {}
            }
          })
        ).run();
        return new Response("Contact added successfully");
      } catch (error) {
        console.error("Error saving contact:", error);
        return new Response("Failed to add contact", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/neworg") {
      const data = await request.json();
      try {
        let insertQuery, insertParams;
        if (data.location_osm_id) {
          insertQuery = `INSERT INTO organizations (name, status, location_osm_id) VALUES (?, ?, ?)`;
          insertParams = [data.name, data.status, data.location_osm_id];
        } else {
          insertQuery = `INSERT INTO organizations (name, status) VALUES (?, ?)`;
          insertParams = [data.name, data.status];
        }
        const res = await env.DB.prepare(insertQuery).bind(...insertParams).run();
        const orgIdResult = await env.DB.prepare(
          data.location_osm_id ? `SELECT id FROM organizations WHERE name = ? AND status = ? AND location_osm_id = ? ORDER BY id DESC LIMIT 1` : `SELECT id FROM organizations WHERE name = ? AND status = ? ORDER BY id DESC LIMIT 1`
        ).bind(
          ...data.location_osm_id ? [data.name, data.status, data.location_osm_id] : [data.name, data.status]
        ).first();
        if (orgIdResult && orgIdResult.id) {
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "insert",
          "organizations",
          parseInt(orgIdResult.id, 10),
          data.created_by ? parseInt(data.created_by, 10) : null,
          JSON.stringify({
            fields: {
              name: { old: null, new: data.name },
              status: { old: null, new: data.status },
              ...data.location_osm_id ? { location_osm_id: { old: null, new: data.location_osm_id } } : {}
            }
          })
        ).run();
        }
        return new Response("Organization added successfully");
      } catch (error) {
        console.error("Error saving organization:", error);
        return new Response("Failed to add organization", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/log-conversation") {
      const data = await request.json();
      try {
        if (!data.contact_id) {
          return new Response("Missing contact_id (must be unique, selected from UI)", { status: 400 });
        }
        if (!data.channel) {
          return new Response("Missing channel", { status: 400 });
        }
        const insertQuery = `INSERT INTO conversations (contact_id, channel, note, created_by) VALUES (?, ?, ?, ?)`;
        const res = await env.DB.prepare(insertQuery).bind(
          parseInt(data.contact_id, 10),
          data.channel,
          data.note,
          data.created_by ? parseInt(data.created_by, 10) : null
        ).run();
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "insert",
          "conversations",
          parseInt(data.contact_id, 10),
          data.created_by ? parseInt(data.created_by, 10) : null,
          JSON.stringify({
            fields: {
              contact_id: { old: null, new: parseInt(data.contact_id, 10) },
              channel: { old: null, new: data.channel },
              note: { old: null, new: data.note },
              created_by: { old: null, new: data.created_by ? parseInt(data.created_by, 10) : null }
            }
          })
        ).run();
        return new Response("Conversation logged successfully");
      } catch (error) {
        console.error("Error logging conversation:", error);
        return new Response(`Failed to log conversation: ${error && error.message ? error.message : error}`, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/delete-team-member") {
      const { telegram_id } = await request.json();
      if (!telegram_id) {
        return new Response("Missing telegram_id", { status: 400 });
      }
      try {
        const oldMember = await env.DB.prepare(
          `SELECT id, telegram_id, name, time_zone FROM team_members WHERE telegram_id = ?`
        ).bind(parseInt(telegram_id, 10)).first();
        const deleteQuery = `DELETE FROM team_members WHERE telegram_id = ?`;
        const res = await env.DB.prepare(deleteQuery).bind(parseInt(telegram_id, 10)).run();
        if (oldMember && oldMember.id) {
          await env.DB.prepare(
            `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
          ).bind(
            "delete",
            "team_members",
            parseInt(oldMember.id, 10),
            null,
            JSON.stringify({
              fields: {
                telegram_id: { old: oldMember.telegram_id, new: null },
                name: { old: oldMember.name, new: null },
                time_zone: { old: oldMember.time_zone, new: null }
              }
            })
          ).run();
        }
        return new Response("Team member deleted", { status: 200 });
      } catch (error) {
        console.error("Error deleting team member:", error);
        return new Response("Failed to delete team member", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/channels") {
      try {
        const result = await env.DB.prepare("SELECT id, label FROM channels").all();
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching channels:", error);
        return new Response("Failed to fetch channels", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/team_member_communities") {
      const urlObj = new URL(request.url);
      const telegram_id = urlObj.searchParams.get("telegram_id");
      if (!telegram_id) {
        return new Response("Missing telegram_id", { status: 400 });
      }
      try {
        const member = await env.DB.prepare("SELECT id FROM team_members WHERE telegram_id = ?").bind(parseInt(telegram_id, 10)).first();
        if (!member || !member.id) {
          return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
        }
        const result = await env.DB.prepare(`
          SELECT c.id, c.name, c.country, c.region
          FROM team_member_communities tmc
          JOIN bitcoin_communities c ON tmc.community_id = c.id
          WHERE tmc.team_member_id = ?
        `).bind(parseInt(member.id, 10)).all();
        console.log("team_member_communities result:", JSON.stringify(result.results));
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching team member communities:", error);
        return new Response("Failed to fetch team member communities", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/contact_types") {
      try {
        const result = await env.DB.prepare("SELECT id, label FROM contact_types").all();
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching contact_types:", error);
        return new Response("Failed to fetch contact_types", { status: 500 });
      }
    }
    if (request.method === "GET" && (url.pathname === "/communities" || url.pathname === "/bitcoin_communities")) {
      try {
        const urlObj = new URL(request.url);
        const country = urlObj.searchParams.get("country");
        let query = "SELECT id, name, country FROM bitcoin_communities";
        const params = [];
        if (country) {
          query += " WHERE country = ?";
          params.push(country);
        }
        const result = await env.DB.prepare(query).bind(...params).all();
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching communities:", error);
        return new Response("Failed to fetch communities", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/community_countries") {
      try {
        const result = await env.DB.prepare("SELECT DISTINCT country FROM bitcoin_communities").all();
        const countries = result.results.map((r) => r.country);
        return new Response(JSON.stringify(countries), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error fetching community countries:", error);
        return new Response("Failed to fetch community countries", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/organizations/search")) {
      const urlObj = new URL(request.url);
      const domain = urlObj.searchParams.get("domain");
      const name = urlObj.searchParams.get("name");
      const email = urlObj.searchParams.get("email");
      const community_id = urlObj.searchParams.get("community_id");
      let query = `
        SELECT o.id, o.name, o.website, o.location_osm_id, o.status, o.nostr_npub,
               bc.id AS community_id, bc.name AS community_name, bc.region, bc.country,
               CASE
                 WHEN oc.community_id = ? THEN 1 ELSE 0
               END AS is_priority_community
        FROM organizations o
        LEFT JOIN organization_communities oc ON o.id = oc.organization_id
        LEFT JOIN bitcoin_communities bc ON oc.community_id = bc.id
        LEFT JOIN contact_emails ce ON o.id = ce.contact_id
        WHERE 1=1
      `;
      const params = [community_id ? parseInt(community_id, 10) : null];
      if (domain) {
        query += " AND o.website LIKE ?";
        params.push(`%${domain}%`);
      }
      if (name) {
        query += " AND o.name LIKE ? COLLATE NOCASE";
        params.push(`%${name}%`);
      }
      if (email) {
        query += " AND (ce.email LIKE ? OR o.website LIKE ?)";
        params.push(`%${email}%`, `%${email}%`);
      }
      query += `
        GROUP BY o.id
        ORDER BY is_priority_community DESC, o.name ASC
      `;
      try {
        const result = await env.DB.prepare(query).bind(...params).all();
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error searching organizations:", error);
        return new Response("Failed to search organizations", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/contacts/search")) {
      const urlObj = new URL(request.url);
      const name = urlObj.searchParams.get("name");
      let query = `
        SELECT contacts.id, contacts.name, organizations.name AS organization_name
        FROM contacts
        LEFT JOIN organizations ON contacts.organization_id = organizations.id
        WHERE 1=1
      `;
      const params = [];
      if (name) {
        query += " AND contacts.name LIKE ? COLLATE NOCASE";
        params.push(`%${name}%`);
      }
      try {
        const result = await env.DB.prepare(query).bind(...params).all();
        return new Response(JSON.stringify(result.results), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error searching contacts:", error);
        return new Response("Failed to search contacts", { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/team_members/count") {
      try {
        const result = await env.DB.prepare("SELECT COUNT(*) as count FROM team_members").first();
        return new Response(JSON.stringify({ count: result.count }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (error) {
        console.error("Error counting team_members:", error);
        return new Response("Failed to count team_members", { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/organization_communities") {
      const data = await request.json();
      if (!data.organization_id || !Array.isArray(data.community_ids)) {
        return new Response("Missing organization_id or community_ids", { status: 400 });
      }
      try {
        // Delete existing associations
        await env.DB.prepare(
          `DELETE FROM organization_communities WHERE organization_id = ?`
        ).bind(parseInt(data.organization_id, 10)).run();
        // Insert new associations
        for (const community_id of data.community_ids) {
          await env.DB.prepare(
            `INSERT INTO organization_communities (organization_id, community_id) VALUES (?, ?)`
          ).bind(parseInt(data.organization_id, 10), parseInt(community_id, 10)).run();
        }
        return new Response("Organization communities updated", { status: 200 });
      } catch (error) {
        console.error("Error updating organization communities:", error);
        return new Response("Failed to update organization communities", { status: 500 });
      }
    }

    // First user registration: only allowed if no team members exist
    if (request.method === "POST" && url.pathname === "/first-user") {
      const data = await request.json();
      if (!data.telegram_id || !data.name) {
        console.error("First user registration: missing telegram_id or name", { data });
        return new Response("Missing telegram_id or name", { status: 400 });
      }
      try {
        // Check if any team members exist
        const countResult = await env.DB.prepare("SELECT COUNT(*) as count FROM team_members").first();
        console.log("First user registration: team_members count result", { countResult, data });
        if (countResult && countResult.count > 0) {
          console.warn("First user registration not allowed: team members already exist", { countResult, data });
          return new Response("First user registration not allowed: team members already exist", { status: 409 });
        }
        // Insert new team member (reuse logic from /team_member)
        const insertQuery = data.time_zone
          ? `INSERT INTO team_members (telegram_id, name, time_zone) VALUES (?, ?, ?)`
          : `INSERT INTO team_members (telegram_id, name) VALUES (?, ?)`;
        const insertParams = data.time_zone
          ? [parseInt(data.telegram_id, 10), data.name, data.time_zone]
          : [parseInt(data.telegram_id, 10), data.name];
        console.log("First user registration: insertQuery and params", { insertQuery, insertParams });
        const res = await env.DB.prepare(insertQuery).bind(...insertParams).run();
        console.log("First user registration: insert result", { res });
        const newMember = await env.DB.prepare(
          `SELECT id FROM team_members WHERE telegram_id = ?`
        ).bind(parseInt(data.telegram_id, 10)).first();
        console.log("First user registration: newMember select result", { newMember });
        await env.DB.prepare(
          `INSERT INTO audit_log (action, table_name, record_id, performed_by, change_details) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          "insert",
          "team_members",
          parseInt(newMember.id, 10),
          null,
          JSON.stringify({
            fields: {
              telegram_id: { old: null, new: data.telegram_id },
              name: { old: null, new: data.name },
              ...(data.time_zone ? { time_zone: { old: null, new: data.time_zone } } : {})
            }
          })
        ).run();
        console.log("First user registration: audit_log insert complete");
        return Response.json({ id: newMember.id, created: true });
      } catch (error) {
        console.error("Error saving first user:", {
          error: error && error.stack ? error.stack : error,
          data
        });
        return new Response("Failed to add first user", { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
