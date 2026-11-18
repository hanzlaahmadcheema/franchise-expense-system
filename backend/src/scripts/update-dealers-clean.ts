import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://franchise_dev:franchise_dev_secret@localhost:5432/franchise_dev_db"
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Remove DO Rizwan & DSO Waseem Gujjar
    await client.query("DELETE FROM stock_accounts WHERE slug IN ('do-rizwan', 'waseem-gujjar') OR name IN ('DO RIZWAN', 'WASEEM GUJJAR')");

    // 2. Clean names and update Free SIM to STOCK
    const nameMap: Record<string, { name: string; type: string }> = {
      "do-mirza": { name: "Mirza", type: "DO" },
      "do-adnan": { name: "Adnan", type: "DO" },
      "do-arslan": { name: "Arslan", type: "DO" },
      "do-mubashar": { name: "Mubashir", type: "DO" },
      "do-mirza-irfan": { name: "Irfan Mirza", type: "DO" },
      "do-hassan": { name: "Hassan", type: "DO" },
      "do-naveed": { name: "Naveed", type: "DO" },
      "do-irfan": { name: "Irfan", type: "DO" },
      "dso-hasan": { name: "Hasan", type: "DSO" },
      "dso-abdullah": { name: "Abdullah", type: "DSO" },
      "anni-ccr": { name: "Anni", type: "CCR" },
      "saram-ccr": { name: "Saram", type: "CCR" },
      "hussain-ccr": { name: "Hussain", type: "CCR" },
      "free-sim-ccr": { name: "Free SIM", type: "STOCK" },
      "net-stock": { name: "Net Stock", type: "STOCK" }
    };

    for (const [slug, data] of Object.entries(nameMap)) {
      await client.query(
        'UPDATE stock_accounts SET name = $1, type = $2 WHERE slug = $3',
        [data.name, data.type, slug]
      );
    }

    // 3. Update Jazz DO profiles: Fix Line -> Office Line, Fakhar -> Fakhar (Tetas)
    await client.query("UPDATE jazz_load_do_profiles SET do_name = 'Office Line' WHERE do_name = 'Fix Line'");
    await client.query("UPDATE jazz_load_do_profiles SET do_name = 'Fakhar (Tetas)' WHERE do_name = 'Fakhar'");

    // Get franchise_id from an existing account
    const fRes = await client.query("SELECT franchise_id FROM stock_accounts LIMIT 1");
    const franchiseId = fRes.rows[0].franchise_id;

    // 4. Ensure Office Line, Fakhar (Tetas), Naveed Bangla, Other exist in stock_accounts
    const missingInStock = [
      { slug: "office-line", name: "Office Line", type: "OFFICE", sort_order: 10, line: "03027107343" },
      { slug: "fakhar-tetas", name: "Fakhar (Tetas)", type: "DO", sort_order: 12, line: "03027108872" },
      { slug: "naveed-bangla", name: "Naveed Bangla", type: "DO", sort_order: 9, line: "03017211475" },
      { slug: "other", name: "Other", type: "DO", sort_order: 14, line: "03200926230" }
    ];

    for (const item of missingInStock) {
      const existing = await client.query("SELECT id FROM stock_accounts WHERE slug = $1", [item.slug]);
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO stock_accounts (franchise_id, slug, name, type, sort_order, is_active, notes)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [franchiseId, item.slug, item.name, item.type, item.sort_order, item.line ? `Line: ${item.line}` : null]
        );
      } else {
        await client.query(
          `UPDATE stock_accounts SET name = $1, type = $2, sort_order = $3, notes = $4 WHERE slug = $5`,
          [item.name, item.type, item.sort_order, item.line ? `Line: ${item.line}` : null, item.slug]
        );
      }
    }

    await client.query("COMMIT");
    console.log("Database updated successfully!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating database:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
