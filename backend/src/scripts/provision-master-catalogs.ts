/**
 * Phase 7C: Master Catalog & Reference Data Provisioning Script
 *
 * HARD CONSTRAINTS:
 * 1. DO NOT initialize September 2026.
 * 2. DO NOT create any September period or days.
 * 3. DO NOT stage any opening seeds.
 * 4. DO NOT verify or activate September.
 * 5. DO NOT create accounting transactions.
 * 6. DO NOT migrate historical transactions.
 * 7. DO NOT modify, delete, or write anything to Firestore.
 * 8. DO NOT modify application schema or create unnecessary migrations.
 * 9. Do not guess mappings.
 * 10. Do not silently rename business entities.
 * 11. Do not alter opening values (no balances/quantities inserted).
 * 12. Strictly report dev/prod environment details.
 */
import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";

export interface ProvisioningSummary {
  environment: {
    database: string;
    user: string;
    port: number;
    host: string;
  };
  franchise: {
    id: string;
    code: string;
    name: string;
    brandName: string;
    isCreated: boolean;
  };
  owner: {
    userId: string;
    email: string;
    displayName: string | null;
    membershipId: string;
    role: string;
    isCreated: boolean;
  };
  creditParties: Array<{
    id: string;
    name: string;
    slug: string;
    type: string;
    status: "created" | "existing";
  }>;
  stockProducts: Array<{
    id: string;
    name: string;
    slug: string;
    rate: number;
    paymentTracking: boolean;
    status: "created" | "existing";
  }>;
  stockAccounts: Array<{
    id: string;
    name: string;
    slug: string;
    type: string;
    status: "created" | "existing";
  }>;
  jazzLoadDoProfiles: Array<{
    id: string;
    name: string;
    line: string | null;
    firestoreLocation: string;
    notes: string | null;
    status: "created" | "existing";
  }>;
  jazzLoadRate: {
    id: string;
    name: string;
    mlRate: number;
    comm1Rate: number;
    comm2Rate: number;
    effectiveFrom: string;
    status: "created" | "existing";
  };
}

export async function provisionMasterCatalogs(): Promise<ProvisioningSummary> {
  // 1. Identify Environment
  const connCheck = await sql<{
    current_database: string;
    current_user: string;
    inet_server_port: number;
    inet_server_addr: string;
  }>`SELECT current_database(), current_user, inet_server_port(), inet_server_addr()`.execute(db);

  const conn = connCheck.rows[0]!;
  const envInfo = {
    database: conn.current_database,
    user: conn.current_user,
    port: Number(conn.inet_server_port),
    host: String(conn.inet_server_addr)
  };

  return db.transaction().execute(async (trx) => {
    // 2. Franchise Provisioning (Section 6)
    const existingFranchise = await trx
      .selectFrom("franchises")
      .selectAll()
      .where("code", "=", "7301")
      .executeTakeFirst();

    let franchiseId: string;
    let franchiseIsCreated = false;

    if (existingFranchise) {
      franchiseId = existingFranchise.id;
    } else {
      const inserted = await trx
        .insertInto("franchises")
        .values({
          code: "7301",
          name: "Jazz Franchise - 7301",
          brand_name: "Jazz Franchise - 7301",
          is_active: true
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      franchiseId = inserted.id;
      franchiseIsCreated = true;
    }

    const franchiseRow = await trx
      .selectFrom("franchises")
      .selectAll()
      .where("id", "=", franchiseId)
      .executeTakeFirstOrThrow();

    // 3. Owner User Provisioning (Section 7)
    const ownerEmail = "hanzlaahmad100@gmail.com";
    const ownerUid = "102082746773415165484";

    const existingUser = await trx
      .selectFrom("users")
      .selectAll()
      .where("email", "=", ownerEmail)
      .executeTakeFirst();

    let userId: string;
    let userIsCreated = false;

    if (existingUser) {
      userId = existingUser.id;
    } else {
      const insertedUser = await trx
        .insertInto("users")
        .values({
          firebase_uid: ownerUid,
          email: ownerEmail,
          display_name: "Hanzla Ahmad",
          is_active: true
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      userId = insertedUser.id;
      userIsCreated = true;
    }

    // Membership in franchise_users
    const existingMembership = await trx
      .selectFrom("franchise_users")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    let membershipId: string;
    if (existingMembership) {
      membershipId = existingMembership.id;
      if (existingMembership.role !== "owner" || !existingMembership.is_active) {
        await trx
          .updateTable("franchise_users")
          .set({ role: "owner", is_active: true })
          .where("id", "=", membershipId)
          .execute();
      }
    } else {
      const insertedMembership = await trx
        .insertInto("franchise_users")
        .values({
          franchise_id: franchiseId,
          user_id: userId,
          role: "owner",
          is_active: true
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      membershipId = insertedMembership.id;
    }

    // Authorized Email
    const existingAuthEmail = await trx
      .selectFrom("authorized_emails")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("email", "=", ownerEmail)
      .executeTakeFirst();

    if (!existingAuthEmail) {
      await trx
        .insertInto("authorized_emails")
        .values({
          franchise_id: franchiseId,
          email: ownerEmail,
          role: "owner",
          is_active: true,
          created_by_user_id: userId
        })
        .execute();
    }

    // 4. Expense Credit Parties (Section 1) - 9 Exact Business Names
    const creditPartiesConfig = [
      { name: "ALI OLAKH", slug: "ali-olakh", type: "dealer", sort_order: 1 },
      { name: "Usman cheema", slug: "usman-cheema", type: "dealer", sort_order: 2 },
      { name: "AKHTAR", slug: "akhtar", type: "dealer", sort_order: 3 },
      { name: "IMRAN OLAKH", slug: "imran-olakh", type: "dealer", sort_order: 4 },
      { name: "Majid ACCOUNT", slug: "majid-account", type: "dealer", sort_order: 5 },
      { name: "DSO HASAN", slug: "dso-hasan", type: "dso", sort_order: 6 },
      { name: "SARAM", slug: "saram", type: "dealer", sort_order: 7 },
      { name: "NAVEED DO", slug: "naveed-do", type: "dealer", sort_order: 8 },
      { name: "FAKHAR CCR", slug: "fakhar-ccr", type: "dealer", sort_order: 9 }
    ] as const;

    const creditPartiesSummary: ProvisioningSummary["creditParties"] = [];

    for (const cp of creditPartiesConfig) {
      const existing = await trx
        .selectFrom("credit_parties")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("slug", "=", cp.slug)
        .executeTakeFirst();

      if (existing) {
        creditPartiesSummary.push({
          id: existing.id,
          name: existing.name,
          slug: existing.slug,
          type: existing.type,
          status: "existing"
        });
      } else {
        const created = await trx
          .insertInto("credit_parties")
          .values({
            franchise_id: franchiseId,
            slug: cp.slug,
            name: cp.name,
            type: cp.type,
            sort_order: cp.sort_order,
            is_active: true
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        creditPartiesSummary.push({
          id: created.id,
          name: created.name,
          slug: created.slug,
          type: created.type,
          status: "created"
        });
      }
    }

    // 5. Stock Products (Section 2) - 11 Exact Business Names with Authoritative Spreadsheet Rates
    const stockProductsConfig = [
      { name: "RETAILER", slug: "retailer", rate: 280, sort_order: 1, payment_tracking: true, category: "SIM" },
      { name: "FRANCHISE", slug: "franchise", rate: 350, sort_order: 2, payment_tracking: true, category: "SIM" },
      { name: "LOAD SIM", slug: "load-sim", rate: 1000, sort_order: 3, payment_tracking: true, category: "SIM" },
      { name: "MBB SIM", slug: "mbb-sim", rate: 500, sort_order: 4, payment_tracking: true, category: "SIM" },
      { name: "E SIM", slug: "e-sim", rate: 2000, sort_order: 5, payment_tracking: true, category: "SIM" },
      { name: "Shine Mobile", slug: "shine-mobile", rate: 7400, sort_order: 6, payment_tracking: true, category: "MOBILE" },
      { name: "MOBILE", slug: "mobile", rate: 5350, sort_order: 7, payment_tracking: true, category: "MOBILE" },
      { name: "WINGLE", slug: "wingle", rate: 2100, sort_order: 8, payment_tracking: true, category: "DEVICES" },
      { name: "Gold Number", slug: "gold-number", rate: 390, sort_order: 9, payment_tracking: true, category: "SIM" },
      { name: "RETAIL IMZI", slug: "retail-imzi", rate: 280, sort_order: 10, payment_tracking: true, category: "IMZI" },
      { name: "CS IMZI", slug: "cs-imzi", rate: 390, sort_order: 11, payment_tracking: true, category: "IMZI" }
    ] as const;

    const stockProductsSummary: ProvisioningSummary["stockProducts"] = [];

    for (const sp of stockProductsConfig) {
      const existing = await trx
        .selectFrom("stock_products")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("slug", "=", sp.slug)
        .executeTakeFirst();

      if (existing) {
        stockProductsSummary.push({
          id: existing.id,
          name: existing.name,
          slug: existing.slug,
          rate: Number(existing.rate),
          paymentTracking: existing.payment_tracking_enabled,
          status: "existing"
        });
      } else {
        const created = await trx
          .insertInto("stock_products")
          .values({
            franchise_id: franchiseId,
            slug: sp.slug,
            name: sp.name,
            rate: sp.rate,
            payment_tracking_enabled: sp.payment_tracking,
            category: sp.category,
            sort_order: sp.sort_order,
            is_active: true
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        stockProductsSummary.push({
          id: created.id,
          name: created.name,
          slug: created.slug,
          rate: Number(created.rate),
          paymentTracking: created.payment_tracking_enabled,
          status: "created"
        });
      }
    }

    // 6. Stock Accounts / Dealers (Section 3) - 17 Exact Business Names
    const stockAccountsConfig = [
      { name: "DO RIZWAN", slug: "do-rizwan", type: "DO" as const, sort_order: 1 },
      { name: "DO MIRZA", slug: "do-mirza", type: "DO" as const, sort_order: 2 },
      { name: "DO ADNAN", slug: "do-adnan", type: "DO" as const, sort_order: 3 },
      { name: "DO ARSLAN", slug: "do-arslan", type: "DO" as const, sort_order: 4 },
      { name: "DO MUBASHAR", slug: "do-mubashar", type: "DO" as const, sort_order: 5 },
      { name: "Do Mirza irfan", slug: "do-mirza-irfan", type: "DO" as const, sort_order: 6 },
      { name: "DO HASSAN", slug: "do-hassan", type: "DO" as const, sort_order: 7 },
      { name: "DO NAVEED", slug: "do-naveed", type: "DO" as const, sort_order: 8 },
      { name: "DO IRFAN", slug: "do-irfan", type: "DO" as const, sort_order: 9 },
      { name: "DSO HASAN", slug: "dso-hasan", type: "DSO" as const, sort_order: 10 },
      { name: "FREE SIM CCR", slug: "free-sim-ccr", type: "CCR" as const, sort_order: 11 },
      { name: "HUSSAIN CCR", slug: "hussain-ccr", type: "CCR" as const, sort_order: 12 },
      { name: "SARAM CCR", slug: "saram-ccr", type: "CCR" as const, sort_order: 13 },
      { name: "ANNI CCR", slug: "anni-ccr", type: "CCR" as const, sort_order: 14 },
      { name: "WASEEM GUJJAR", slug: "waseem-gujjar", type: "DSO" as const, sort_order: 15 },
      { name: "DSO Abdullah", slug: "dso-abdullah", type: "DSO" as const, sort_order: 16 },
      { name: "NET STOCK", slug: "net-stock", type: "STOCK" as const, sort_order: 17 }
    ];

    const stockAccountsSummary: ProvisioningSummary["stockAccounts"] = [];

    for (const sa of stockAccountsConfig) {
      const existing = await trx
        .selectFrom("stock_accounts")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("slug", "=", sa.slug)
        .executeTakeFirst();

      if (existing) {
        stockAccountsSummary.push({
          id: existing.id,
          name: existing.name,
          slug: existing.slug,
          type: existing.type,
          status: "existing"
        });
      } else {
        const created = await trx
          .insertInto("stock_accounts")
          .values({
            franchise_id: franchiseId,
            slug: sa.slug,
            name: sa.name,
            type: sa.type,
            sort_order: sa.sort_order,
            is_active: true
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        stockAccountsSummary.push({
          id: created.id,
          name: created.name,
          slug: created.slug,
          type: created.type,
          status: "created"
        });
      }
    }

    // 7. Jazz Load DO Profiles (Section 4) - Discovered from Firestore read-only
    // Discovered from Firestore collections: jazzLoadSettings/doNames, jazzLoadSettings/doLines, jazzLoadSettings/doLineBindings
    const jazzDoProfilesConfig = [
      {
        do_name: "Mirza",
        do_line: "03051639672",
        sort_order: 1,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03051639672-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Mirza, line: 03051639672)"
      },
      {
        do_name: "Adnan",
        do_line: "03017211714",
        sort_order: 2,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03017211714-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Adnan, line: 03017211714)"
      },
      {
        do_name: "Arslan",
        do_line: "03027100125",
        sort_order: 3,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027100125-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Arslan, line: 03027100125)"
      },
      {
        do_name: "Mubashir",
        do_line: "03027100126",
        sort_order: 4,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027100126-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Mubashir, line: 03027100126). Known as MUBASHAR in September workbook."
      },
      {
        do_name: "Irfan Mirza",
        do_line: "03027103467",
        sort_order: 5,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027103467-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Irfan Mirza, line: 03027103467)"
      },
      {
        do_name: "Hassan",
        do_line: "03027103468",
        sort_order: 6,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027103468-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Hassan, line: 03027103468)"
      },
      {
        do_name: "Naveed",
        do_line: "03030963707",
        sort_order: 7,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03030963707-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Naveed, line: 03030963707)"
      },
      {
        do_name: "Irfan",
        do_line: "03030964504",
        sort_order: 8,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03030964504-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Irfan, line: 03030964504)"
      },
      {
        do_name: "Naveed Bangla",
        do_line: "03017211475",
        sort_order: 9,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03017211475-2026-06-01",
        notes: "Discovered from Firestore doLineBindings (doName: Naveed Bangla, line: 03017211475). Note conflict: labeled RIZWAN in September 2026 workbook."
      },
      {
        do_name: "Fix Line",
        do_line: "03027107343",
        sort_order: 10,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027107343-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Fix Line, line: 03027107343). Note conflict: labeled OFFICE in September 2026 workbook."
      },
      {
        do_name: "Anni",
        do_line: "03087081311",
        sort_order: 11,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03000000000-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Anni, line: 03087081311)"
      },
      {
        do_name: "Fakhar",
        do_line: "03027108872",
        sort_order: 12,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03027108872-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Fakhar, line: 03027108872). Note conflict: labeled HUSSAIN in September 2026 workbook."
      },
      {
        do_name: "Saram",
        do_line: "03250919702",
        sort_order: 13,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03010769852-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Saram, line: 03250919702)"
      },
      {
        do_name: "Other",
        do_line: "03200926230",
        sort_order: 14,
        firestore_location: "jazzLoadSettings/doLineBindings/items/03200926230-2026-07-01",
        notes: "Discovered from Firestore doLineBindings (doName: Other, line: 03200926230)"
      }
    ];

    const jazzDoProfilesSummary: ProvisioningSummary["jazzLoadDoProfiles"] = [];

    for (const jp of jazzDoProfilesConfig) {
      const existing = await trx
        .selectFrom("jazz_load_do_profiles")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("do_name", "=", jp.do_name)
        .where("do_line", "=", jp.do_line)
        .executeTakeFirst();

      if (existing) {
        jazzDoProfilesSummary.push({
          id: existing.id,
          name: existing.do_name,
          line: existing.do_line,
          firestoreLocation: jp.firestore_location,
          notes: existing.notes,
          status: "existing"
        });
      } else {
        const created = await trx
          .insertInto("jazz_load_do_profiles")
          .values({
            franchise_id: franchiseId,
            do_name: jp.do_name,
            do_line: jp.do_line,
            sort_order: jp.sort_order,
            is_active: true,
            notes: jp.notes
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        jazzDoProfilesSummary.push({
          id: created.id,
          name: created.do_name,
          line: created.do_line,
          firestoreLocation: jp.firestore_location,
          notes: created.notes,
          status: "created"
        });
      }
    }

    // 8. Jazz Load Rates (Section 5)
    // Authoritative rates: ML: 2.4%, Comm1: 2.4%, Comm2: 1.16%, Effective Date: 2026-09-01
    const existingRate = await trx
      .selectFrom("jazz_load_rates")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("effective_from", "=", "2026-09-01")
      .where("name", "=", "Standard Rates - September 2026")
      .executeTakeFirst();

    let rateSummary: ProvisioningSummary["jazzLoadRate"];

    if (existingRate) {
      rateSummary = {
        id: existingRate.id,
        name: existingRate.name,
        mlRate: Number(existingRate.ml_rate),
        comm1Rate: Number(existingRate.comm1_rate),
        comm2Rate: Number(existingRate.comm2_rate),
        effectiveFrom: existingRate.effective_from,
        status: "existing"
      };
    } else {
      const createdRate = await trx
        .insertInto("jazz_load_rates")
        .values({
          franchise_id: franchiseId,
          name: "Standard Rates - September 2026",
          ml_rate: 2.4,
          comm1_rate: 2.4,
          comm2_rate: 1.16,
          effective_from: "2026-09-01",
          is_active: true
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      rateSummary = {
        id: createdRate.id,
        name: createdRate.name,
        mlRate: Number(createdRate.ml_rate),
        comm1Rate: Number(createdRate.comm1_rate),
        comm2Rate: Number(createdRate.comm2_rate),
        effectiveFrom: createdRate.effective_from,
        status: "created"
      };
    }

    return {
      environment: envInfo,
      franchise: {
        id: franchiseRow.id,
        code: franchiseRow.code,
        name: franchiseRow.name,
        brandName: franchiseRow.brand_name,
        isCreated: franchiseIsCreated
      },
      owner: {
        userId,
        email: ownerEmail,
        displayName: "Hanzla Ahmad",
        membershipId,
        role: "owner",
        isCreated: userIsCreated
      },
      creditParties: creditPartiesSummary,
      stockProducts: stockProductsSummary,
      stockAccounts: stockAccountsSummary,
      jazzLoadDoProfiles: jazzDoProfilesSummary,
      jazzLoadRate: rateSummary
    };
  });
}

// Direct execution when invoked from CLI
if (process.argv[1]?.endsWith("provision-master-catalogs.ts") || process.argv[1]?.endsWith("provision-master-catalogs.js")) {
  provisionMasterCatalogs()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Provisioning error:", err);
      process.exit(1);
    })
    .finally(async () => {
      await closeDatabase();
    });
}
