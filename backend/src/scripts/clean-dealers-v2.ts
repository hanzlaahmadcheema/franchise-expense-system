import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://franchise_dev:franchise_dev_secret@localhost:5432/franchise_dev_db"
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Delete removed accounts (Rizwan, Waseem Gujjar, Ghot Hussain)
    await client.query(`
      DELETE FROM stock_accounts 
      WHERE slug ILIKE '%rizwan%' 
         OR slug ILIKE '%waseem%' 
         OR name ILIKE '%rizwan%' 
         OR name ILIKE '%waseem%'
         OR name ILIKE '%ghot%';
    `);
    await client.query(`
      DELETE FROM jazz_load_do_profiles 
      WHERE do_name ILIKE '%rizwan%' 
         OR do_name ILIKE '%waseem%'
         OR do_name ILIKE '%ghot%';
    `);

    // Get franchise_id
    const fRes = await client.query("SELECT franchise_id FROM stock_accounts LIMIT 1");
    const franchiseId = fRes.rows[0].franchise_id;

    // 2. Exact Canonical Master List
    const canonicalDealers = [
      { name: "Mirza", type: "DO", sort: 1, line: "03051639672", load: true, stock: true },
      { name: "Adnan", type: "DO", sort: 2, line: "03017211714", load: true, stock: true },
      { name: "Arslan", type: "DO", sort: 3, line: "03027100125", load: true, stock: true },
      { name: "Mubashir", type: "DO", sort: 4, line: "03027100126", load: true, stock: true },
      { name: "Irfan Mirza", type: "DO", sort: 5, line: "03027103467", load: true, stock: true },
      { name: "Hassan", type: "DO", sort: 6, line: "03027103468", load: true, stock: true },
      { name: "Naveed", type: "DO", sort: 7, line: "03030963707", load: true, stock: true },
      { name: "Irfan", type: "DO", sort: 8, line: "03030964504", load: true, stock: true },
      { name: "Naveed Bangla", type: "DO", sort: 9, line: "03017211475", load: true, stock: true },
      { name: "Office Line 1", type: "OFFICE", sort: 10, line: "03027107343", load: true, stock: true },
      { name: "Office Line 2", type: "OFFICE", sort: 11, line: "03200926230", load: true, stock: true },
      { name: "Fakhar (Titus)", type: "CCR", sort: 12, line: "03027108872", load: true, stock: true },
      { name: "Anni", type: "CCR", sort: 13, line: "03087081311", load: true, stock: true },
      { name: "Saram", type: "CCR", sort: 14, line: "03250919702", load: true, stock: true },
      { name: "Hussain", type: "CCR", sort: 15, line: null, load: true, stock: true },
      { name: "Hasan", type: "DSO", sort: 16, line: null, load: false, stock: true },
      { name: "Abdullah", type: "DSO", sort: 17, line: null, load: false, stock: true },
      { name: "Free SIM", type: "STOCK", sort: 18, line: null, load: false, stock: true },
      { name: "Net Stock", type: "STOCK", sort: 19, line: null, load: false, stock: true }
    ];

    // 3. Clean up jazz_load_do_profiles
    // First, map existing profiles by line or name pattern
    const jazzProfiles = (await client.query("SELECT id, do_name, do_line FROM jazz_load_do_profiles")).rows;
    for (const d of canonicalDealers) {
      if (!d.load) continue;

      let matchedJp = null;
      if (d.line) {
        matchedJp = jazzProfiles.find((p) => p.do_line === d.line);
      }
      if (!matchedJp) {
        matchedJp = jazzProfiles.find((p) => {
          const pName = p.do_name.toLowerCase().replace(/[^a-z]/g, "");
          const dName = d.name.toLowerCase().replace(/[^a-z]/g, "");
          return pName === dName || (pName.includes("fix") && d.name.includes("Line 1")) || (pName.includes("other") && d.name.includes("Line 2"));
        });
      }

      if (matchedJp) {
        await client.query(
          `UPDATE jazz_load_do_profiles SET do_name = $1, do_line = $2, sort_order = $3, is_active = true WHERE id = $4`,
          [d.name, d.line, d.sort, matchedJp.id]
        );
      } else {
        await client.query(
          `INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line, sort_order, is_active)
           VALUES ($1, $2, $3, $4, true)`,
          [franchiseId, d.name, d.line, d.sort]
        );
      }
    }

    // Delete any remaining jazz profiles that are not in the canonical load list
    const allowedLoadNames = canonicalDealers.filter((d) => d.load).map((d) => d.name);
    await client.query(
      `DELETE FROM jazz_load_do_profiles WHERE do_name NOT IN (${allowedLoadNames.map((_, i) => `$${i + 1}`).join(", ")})`,
      allowedLoadNames
    );

    // 4. Clean up stock_accounts
    const stockAccounts = (await client.query("SELECT id, name, slug, notes FROM stock_accounts")).rows;
    for (const d of canonicalDealers) {
      if (!d.stock) continue;

      let matchedSa = null;
      if (d.line) {
        matchedSa = stockAccounts.find((sa) => sa.notes && sa.notes.includes(d.line));
      }
      if (!matchedSa) {
        matchedSa = stockAccounts.find((sa) => {
          const sName = sa.name.toLowerCase().replace(/[^a-z]/g, "");
          const dName = d.name.toLowerCase().replace(/[^a-z]/g, "");
          return sName === dName || (sName.includes("fix") && d.name.includes("Line 1")) || (sName.includes("other") && d.name.includes("Line 2"));
        });
      }

      const cleanSlug = d.name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
      const notesVal = d.line ? `Line: ${d.line}` : null;

      if (matchedSa) {
        await client.query(
          `UPDATE stock_accounts 
           SET name = $1, type = $2, sort_order = $3, is_active = true, notes = $4 
           WHERE id = $5`,
          [d.name, d.type, d.sort, notesVal, matchedSa.id]
        );
      } else {
        await client.query(
          `INSERT INTO stock_accounts (franchise_id, slug, name, type, sort_order, is_active, notes)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [franchiseId, cleanSlug, d.name, d.type, d.sort, notesVal]
        );
      }
    }

    // Delete any stock accounts not in the canonical list
    const allowedStockNames = canonicalDealers.map((d) => d.name);
    await client.query(
      `DELETE FROM stock_accounts WHERE name NOT IN (${allowedStockNames.map((_, i) => `$${i + 1}`).join(", ")})`,
      allowedStockNames
    );

    await client.query("COMMIT");
    console.log("Canonical Dealers Database Update Complete!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Database update error:", err);
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
