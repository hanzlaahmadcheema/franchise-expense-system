/**
 * Phase 5: Operational Ledger Transaction Services
 *
 * Implements server-authoritative operational transaction services.
 * Every mutation executes in a PostgreSQL transaction, acquires row locks on
 * the accounting day, validates tenant boundary on all referenced foreign keys,
 * verifies OPEN/REOPEN day status, prevents client overrides of generated fields,
 * and maintains audit logging.
 */
import { sql } from "kysely";
import { db } from "../config/database.js";
import type { Timestamp } from "../db/types.js";
import { assertAccountingDayActive } from "./dayLock.js";
import { recordAuditLog } from "./audit.js";
import { NotFoundError, InvalidReferenceError } from "./errors.js";
import type {
  TransactionFilter,
  ExpenseItemCreate,
  ExpenseItemUpdate,
  CommissionItemCreate,
  CommissionItemUpdate,
  CreditTransactionCreate,
  CreditTransactionUpdate,
  OwnerTransactionCreate,
  OwnerTransactionUpdate,
  JazzLiftingCreate,
  JazzLiftingUpdate,
  JazzDoEntryCreate,
  JazzDoEntryUpdate,
  StockOrderCreate,
  StockOrderUpdate,
  StockAccountPaymentCreate,
  StockAccountPaymentUpdate,
  JazzPayablePaymentCreate,
  JazzPayablePaymentUpdate
} from "./schemas.js";

export interface MutationContext {
  franchiseId: string;
  userId: string | null;
  userEmail: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// ===========================================================================
// 1. EXPENSE ITEMS
// ===========================================================================

export async function listExpenses(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("expense_items")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getExpense(franchiseId: string, id: string) {
  return db
    .selectFrom("expense_items")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createExpense(ctx: MutationContext, data: ExpenseItemCreate) {
  return db.transaction().execute(async (trx) => {
    // 1. Lock & validate accounting day
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    // 2. Snapshot category name if category_id is supplied
    let categoryNameSnapshot = data.category_name_snapshot ?? "General";
    if (data.category_id) {
      const cat = await trx
        .selectFrom("expense_categories")
        .select(["name"])
        .where("id", "=", data.category_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!cat) {
        throw new InvalidReferenceError("Referenced expense category does not exist in this franchise.");
      }
      categoryNameSnapshot = cat.name;
    }

    // 3. Insert raw expense fact
    const created = await trx
      .insertInto("expense_items")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        category_id: data.category_id ?? null,
        category_name_snapshot: categoryNameSnapshot,
        item_name: data.item_name,
        description: data.description ?? null,
        amount: data.amount,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 4. Record audit log
    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "expense_item",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateExpense(ctx: MutationContext, id: string, data: ExpenseItemUpdate) {
  return db.transaction().execute(async (trx) => {
    // 1. Lock existing record
    const existing = await sql<any>`
      SELECT * FROM expense_items
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Expense item not found.");
    }
    const item = existing.rows[0];

    // 2. Lock & validate accounting day
    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    // 3. Resolve category snapshot if category_id changed
    let categoryNameSnapshot = item.category_name_snapshot;
    if (data.category_id !== undefined) {
      if (data.category_id === null) {
        categoryNameSnapshot = "General";
      } else {
        const cat = await trx
          .selectFrom("expense_categories")
          .select(["name"])
          .where("id", "=", data.category_id)
          .where("franchise_id", "=", ctx.franchiseId)
          .executeTakeFirst();

        if (!cat) {
          throw new InvalidReferenceError("Referenced expense category does not exist in this franchise.");
        }
        categoryNameSnapshot = cat.name;
      }
    }

    // 4. Update
    const updated = await trx
      .updateTable("expense_items")
      .set({
        category_id: data.category_id !== undefined ? data.category_id : item.category_id,
        category_name_snapshot: categoryNameSnapshot,
        item_name: data.item_name !== undefined ? data.item_name : item.item_name,
        description: data.description !== undefined ? data.description : item.description,
        amount: data.amount !== undefined ? data.amount : item.amount,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // 5. Record audit log
    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "expense_item",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteExpense(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM expense_items
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Expense item not found.");
    }
    const item = existing.rows[0];

    // Lock & validate day
    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("expense_items")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "expense_item",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 2. COMMISSION ITEMS
// ===========================================================================

export async function listCommissions(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("commission_items")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getCommission(franchiseId: string, id: string) {
  return db
    .selectFrom("commission_items")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createCommission(ctx: MutationContext, data: CommissionItemCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    let categoryNameSnapshot = data.category_name_snapshot ?? "Commission";
    if (data.category_id) {
      const cat = await trx
        .selectFrom("commission_categories")
        .select(["name"])
        .where("id", "=", data.category_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!cat) {
        throw new InvalidReferenceError("Referenced commission category does not exist in this franchise.");
      }
      categoryNameSnapshot = cat.name;
    }

    const created = await trx
      .insertInto("commission_items")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        category_id: data.category_id ?? null,
        category_name_snapshot: categoryNameSnapshot,
        amount: data.amount,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "commission_item",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateCommission(ctx: MutationContext, id: string, data: CommissionItemUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM commission_items
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Commission item not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    let categoryNameSnapshot = item.category_name_snapshot;
    if (data.category_id !== undefined) {
      if (data.category_id === null) {
        categoryNameSnapshot = "Commission";
      } else {
        const cat = await trx
          .selectFrom("commission_categories")
          .select(["name"])
          .where("id", "=", data.category_id)
          .where("franchise_id", "=", ctx.franchiseId)
          .executeTakeFirst();

        if (!cat) {
          throw new InvalidReferenceError("Referenced commission category does not exist in this franchise.");
        }
        categoryNameSnapshot = cat.name;
      }
    }

    const updated = await trx
      .updateTable("commission_items")
      .set({
        category_id: data.category_id !== undefined ? data.category_id : item.category_id,
        category_name_snapshot: categoryNameSnapshot,
        amount: data.amount !== undefined ? data.amount : item.amount,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "commission_item",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteCommission(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM commission_items
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Commission item not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("commission_items")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "commission_item",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 3. CREDIT TRANSACTIONS
// ===========================================================================

export async function listCredits(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("credit_transactions")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getCredit(franchiseId: string, id: string) {
  return db
    .selectFrom("credit_transactions")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createCredit(ctx: MutationContext, data: CreditTransactionCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    const party = await trx
      .selectFrom("credit_parties")
      .select(["name"])
      .where("id", "=", data.party_id)
      .where("franchise_id", "=", ctx.franchiseId)
      .executeTakeFirst();

    if (!party) {
      throw new InvalidReferenceError("Referenced credit party does not exist in this franchise.");
    }

    const created = await trx
      .insertInto("credit_transactions")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        party_id: data.party_id,
        party_name_snapshot: party.name,
        loan_amount: data.loan_amount,
        receipt_amount: data.receipt_amount,
        manual_adjustment: data.manual_adjustment,
        loan_description: data.loan_description ?? null,
        receive_description: data.receive_description ?? null,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "credit_transaction",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateCredit(ctx: MutationContext, id: string, data: CreditTransactionUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM credit_transactions
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Credit transaction not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    let partyNameSnapshot = item.party_name_snapshot;
    if (data.party_id && data.party_id !== item.party_id) {
      const party = await trx
        .selectFrom("credit_parties")
        .select(["name"])
        .where("id", "=", data.party_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!party) {
        throw new InvalidReferenceError("Referenced credit party does not exist in this franchise.");
      }
      partyNameSnapshot = party.name;
    }

    const updated = await trx
      .updateTable("credit_transactions")
      .set({
        party_id: data.party_id !== undefined ? data.party_id : item.party_id,
        party_name_snapshot: partyNameSnapshot,
        loan_amount: data.loan_amount !== undefined ? data.loan_amount : item.loan_amount,
        receipt_amount: data.receipt_amount !== undefined ? data.receipt_amount : item.receipt_amount,
        manual_adjustment: data.manual_adjustment !== undefined ? data.manual_adjustment : item.manual_adjustment,
        loan_description: data.loan_description !== undefined ? data.loan_description : item.loan_description,
        receive_description: data.receive_description !== undefined ? data.receive_description : item.receive_description,
        notes: data.notes !== undefined ? data.notes : item.notes,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "credit_transaction",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteCredit(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM credit_transactions
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Credit transaction not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("credit_transactions")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "credit_transaction",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 4. OWNER TRANSACTIONS
// ===========================================================================

export async function listOwnerTransactions(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("owner_transactions")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getOwnerTransaction(franchiseId: string, id: string) {
  return db
    .selectFrom("owner_transactions")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createOwnerTransaction(ctx: MutationContext, data: OwnerTransactionCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    const created = await trx
      .insertInto("owner_transactions")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        description: data.description,
        amount: data.amount,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "owner_transaction",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateOwnerTransaction(ctx: MutationContext, id: string, data: OwnerTransactionUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM owner_transactions
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Owner transaction not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    const updated = await trx
      .updateTable("owner_transactions")
      .set({
        description: data.description !== undefined ? data.description : item.description,
        amount: data.amount !== undefined ? data.amount : item.amount,
        notes: data.notes !== undefined ? data.notes : item.notes,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "owner_transaction",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteOwnerTransaction(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM owner_transactions
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Owner transaction not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("owner_transactions")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "owner_transaction",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 5. JAZZ LOAD LIFTING RECORDS
// ===========================================================================

export async function listJazzLifting(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("jazz_load_lifting_records")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getJazzLifting(franchiseId: string, id: string) {
  return db
    .selectFrom("jazz_load_lifting_records")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createJazzLifting(ctx: MutationContext, data: JazzLiftingCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    const created = await trx
      .insertInto("jazz_load_lifting_records")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        ml_lifting_amount: data.ml_lifting_amount,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "jazz_load_lifting_record",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateJazzLifting(ctx: MutationContext, id: string, data: JazzLiftingUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_load_lifting_records
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Load lifting record not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    const updated = await trx
      .updateTable("jazz_load_lifting_records")
      .set({
        ml_lifting_amount: data.ml_lifting_amount !== undefined ? data.ml_lifting_amount : item.ml_lifting_amount,
        notes: data.notes !== undefined ? data.notes : item.notes
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "jazz_load_lifting_record",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteJazzLifting(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_load_lifting_records
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Load lifting record not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("jazz_load_lifting_records")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "jazz_load_lifting_record",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 6. JAZZ LOAD DO ENTRIES
// ===========================================================================

export async function listJazzDoEntries(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("jazz_load_do_entries")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getJazzDoEntry(franchiseId: string, id: string) {
  return db
    .selectFrom("jazz_load_do_entries")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createJazzDoEntry(ctx: MutationContext, data: JazzDoEntryCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    // Validate and snapshot DO profile
    const profile = await trx
      .selectFrom("jazz_load_do_profiles")
      .select(["do_name", "do_line"])
      .where("id", "=", data.do_profile_id)
      .where("franchise_id", "=", ctx.franchiseId)
      .executeTakeFirst();

    if (!profile) {
      throw new InvalidReferenceError("Referenced Jazz Load DO profile does not exist in this franchise.");
    }

    // Determine applied ML rate percentage:
    // If client supplied valid rate use it, otherwise resolve latest active rate for franchise
    let appliedRate = data.applied_ml_rate_percentage;
    if (appliedRate === undefined) {
      const activeRate = await trx
        .selectFrom("jazz_load_rates")
        .select(["ml_rate"])
        .where("franchise_id", "=", ctx.franchiseId)
        .where("is_active", "=", true)
        .orderBy("effective_from", "desc")
        .executeTakeFirst();

      appliedRate = activeRate ? Number(activeRate.ml_rate) : 2.6;
    }

    const created = await trx
      .insertInto("jazz_load_do_entries")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        do_profile_id: data.do_profile_id,
        do_name_snapshot: profile.do_name,
        do_line_snapshot: profile.do_line,
        issuance_base: data.issuance_base,
        payment_base: data.payment_base,
        applied_ml_rate_percentage: appliedRate,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "jazz_load_do_entry",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateJazzDoEntry(ctx: MutationContext, id: string, data: JazzDoEntryUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_load_do_entries
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Load DO entry not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    let doNameSnapshot = item.do_name_snapshot;
    let doLineSnapshot = item.do_line_snapshot;

    if (data.do_profile_id && data.do_profile_id !== item.do_profile_id) {
      const profile = await trx
        .selectFrom("jazz_load_do_profiles")
        .select(["do_name", "do_line"])
        .where("id", "=", data.do_profile_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!profile) {
        throw new InvalidReferenceError("Referenced Jazz Load DO profile does not exist in this franchise.");
      }
      doNameSnapshot = profile.do_name;
      doLineSnapshot = profile.do_line;
    }

    const updated = await trx
      .updateTable("jazz_load_do_entries")
      .set({
        do_profile_id: data.do_profile_id !== undefined ? data.do_profile_id : item.do_profile_id,
        do_name_snapshot: doNameSnapshot,
        do_line_snapshot: doLineSnapshot,
        issuance_base: data.issuance_base !== undefined ? data.issuance_base : item.issuance_base,
        payment_base: data.payment_base !== undefined ? data.payment_base : item.payment_base,
        applied_ml_rate_percentage: data.applied_ml_rate_percentage !== undefined ? data.applied_ml_rate_percentage : item.applied_ml_rate_percentage,
        notes: data.notes !== undefined ? data.notes : item.notes,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "jazz_load_do_entry",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteJazzDoEntry(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_load_do_entries
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Load DO entry not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("jazz_load_do_entries")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "jazz_load_do_entry",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 7 & 8. STOCK ORDERS & ORDER LINES (PARENT-CHILD)
// ===========================================================================

export interface StockOrderWithLines {
  id: string;
  franchise_id: string;
  day_id: string;
  direction: "inbound" | "outbound";
  account_id: string | null;
  account_name_snapshot: string | null;
  supplier_name: string | null;
  invoice_reference: string | null;
  notes: string | null;
  revision: number;
  created_by_user_id: string | null;
  created_at: Timestamp | Date | string;
  updated_at: Timestamp | Date | string;
  lines: Array<{
    id: string;
    stock_order_id: string;
    product_id: string;
    product_name_snapshot: string;
    unit_rate: string | number;
    quantity: number;
    line_amount: string | number;
    created_at: Timestamp | Date | string;
  }>;
}

export async function listStockOrders(franchiseId: string, filter: TransactionFilter): Promise<StockOrderWithLines[]> {
  let q = db
    .selectFrom("stock_orders")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  const orders = await q.execute();
  if (orders.length === 0) return [];

  const orderIds = orders.map((o) => o.id);
  const lines = await db
    .selectFrom("stock_order_lines")
    .selectAll()
    .where("stock_order_id", "in", orderIds)
    .orderBy("created_at", "asc")
    .execute();

  const linesByOrderId = new Map<string, typeof lines>();
  for (const line of lines) {
    const list = linesByOrderId.get(line.stock_order_id) ?? [];
    list.push(line);
    linesByOrderId.set(line.stock_order_id, list);
  }

  return orders.map((order) => ({
    ...order,
    lines: (linesByOrderId.get(order.id) ?? []) as any
  }));
}

export async function getStockOrder(franchiseId: string, id: string): Promise<StockOrderWithLines | undefined> {
  const order = await db
    .selectFrom("stock_orders")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();

  if (!order) return undefined;

  const lines = await db
    .selectFrom("stock_order_lines")
    .selectAll()
    .where("stock_order_id", "=", id)
    .orderBy("created_at", "asc")
    .execute();

  return {
    ...order,
    lines: lines as any
  };
}

export async function createStockOrder(ctx: MutationContext, data: StockOrderCreate): Promise<StockOrderWithLines> {
  return db.transaction().execute(async (trx) => {
    // 1. Lock accounting day
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    // 2. Validate and snapshot stock account if provided
    let accountNameSnapshot: string | null = null;
    if (data.account_id) {
      const account = await trx
        .selectFrom("stock_accounts")
        .select(["name"])
        .where("id", "=", data.account_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!account) {
        throw new InvalidReferenceError("Referenced stock account does not exist in this franchise.");
      }
      accountNameSnapshot = account.name;
    }

    // 3. Validate and resolve all product lines (fail atomically if any product is invalid)
    const resolvedLines: Array<{
      product_id: string;
      product_name_snapshot: string;
      unit_rate: number;
      quantity: number;
    }> = [];

    for (const line of data.lines) {
      const product = await trx
        .selectFrom("stock_products")
        .select(["name", "rate"])
        .where("id", "=", line.product_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!product) {
        throw new InvalidReferenceError(`Referenced stock product (${line.product_id}) does not exist in this franchise.`);
      }

      const rate = line.unit_rate !== undefined ? line.unit_rate : Number(product.rate);
      resolvedLines.push({
        product_id: line.product_id,
        product_name_snapshot: product.name,
        unit_rate: rate,
        quantity: line.quantity
      });
    }

    // 4. Create Parent Stock Order
    const createdOrder = await trx
      .insertInto("stock_orders")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        direction: data.direction,
        account_id: data.account_id ?? null,
        account_name_snapshot: accountNameSnapshot,
        supplier_name: data.supplier_name ?? "Jazz Company",
        invoice_reference: data.invoice_reference ?? null,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 5. Create Child Order Lines
    // IMPORTANT: line_amount is GENERATED ALWAYS by PostgreSQL (quantity * unit_rate STORED).
    // It is NEVER supplied or manipulated in the application code.
    const createdLines = [];
    for (const line of resolvedLines) {
      const insertedLine = await trx
        .insertInto("stock_order_lines")
        .values({
          stock_order_id: createdOrder.id,
          product_id: line.product_id,
          product_name_snapshot: line.product_name_snapshot,
          unit_rate: line.unit_rate,
          quantity: line.quantity
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      createdLines.push(insertedLine);
    }

    const fullOrder: StockOrderWithLines = {
      ...createdOrder,
      lines: createdLines as any
    };

    // 6. Record audit log
    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "stock_order",
      entityId: createdOrder.id,
      afterState: fullOrder,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return fullOrder;
  });
}

export async function updateStockOrder(ctx: MutationContext, id: string, data: StockOrderUpdate): Promise<StockOrderWithLines> {
  return db.transaction().execute(async (trx) => {
    // 1. Lock existing order
    const existing = await sql<any>`
      SELECT * FROM stock_orders
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Stock order not found.");
    }
    const order = existing.rows[0];

    // 2. Lock accounting day
    await assertAccountingDayActive(trx, ctx.franchiseId, order.day_id);

    // 3. Resolve account snapshot if updated
    let accountNameSnapshot = order.account_name_snapshot;
    if (data.account_id !== undefined) {
      if (data.account_id === null) {
        accountNameSnapshot = null;
      } else {
        const account = await trx
          .selectFrom("stock_accounts")
          .select(["name"])
          .where("id", "=", data.account_id)
          .where("franchise_id", "=", ctx.franchiseId)
          .executeTakeFirst();

        if (!account) {
          throw new InvalidReferenceError("Referenced stock account does not exist in this franchise.");
        }
        accountNameSnapshot = account.name;
      }
    }

    // 4. Update parent order
    const updatedOrder = await trx
      .updateTable("stock_orders")
      .set({
        direction: data.direction !== undefined ? data.direction : order.direction,
        account_id: data.account_id !== undefined ? data.account_id : order.account_id,
        account_name_snapshot: accountNameSnapshot,
        supplier_name: data.supplier_name !== undefined ? data.supplier_name : order.supplier_name,
        invoice_reference: data.invoice_reference !== undefined ? data.invoice_reference : order.invoice_reference,
        notes: data.notes !== undefined ? data.notes : order.notes,
        revision: (order.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // 5. Replace lines if supplied
    let currentLines;
    if (data.lines) {
      // Validate all products
      const resolvedLines: Array<{
        product_id: string;
        product_name_snapshot: string;
        unit_rate: number;
        quantity: number;
      }> = [];

      for (const line of data.lines) {
        const product = await trx
          .selectFrom("stock_products")
          .select(["name", "rate"])
          .where("id", "=", line.product_id)
          .where("franchise_id", "=", ctx.franchiseId)
          .executeTakeFirst();

        if (!product) {
          throw new InvalidReferenceError(`Referenced stock product (${line.product_id}) does not exist in this franchise.`);
        }

        const rate = line.unit_rate !== undefined ? line.unit_rate : Number(product.rate);
        resolvedLines.push({
          product_id: line.product_id,
          product_name_snapshot: product.name,
          unit_rate: rate,
          quantity: line.quantity
        });
      }

      // Delete previous lines
      await trx.deleteFrom("stock_order_lines").where("stock_order_id", "=", id).execute();

      // Insert replacement lines
      currentLines = [];
      for (const line of resolvedLines) {
        const ins = await trx
          .insertInto("stock_order_lines")
          .values({
            stock_order_id: id,
            product_id: line.product_id,
            product_name_snapshot: line.product_name_snapshot,
            unit_rate: line.unit_rate,
            quantity: line.quantity
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        currentLines.push(ins);
      }
    } else {
      currentLines = await trx
        .selectFrom("stock_order_lines")
        .selectAll()
        .where("stock_order_id", "=", id)
        .orderBy("created_at", "asc")
        .execute();
    }

    const fullOrder: StockOrderWithLines = {
      ...updatedOrder,
      lines: currentLines as any
    };

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "stock_order",
      entityId: id,
      beforeState: order,
      afterState: fullOrder,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return fullOrder;
  });
}

export async function deleteStockOrder(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM stock_orders
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Stock order not found.");
    }
    const order = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, order.day_id);

    const lines = await trx
      .selectFrom("stock_order_lines")
      .selectAll()
      .where("stock_order_id", "=", id)
      .execute();

    const fullOrder = { ...order, lines };

    // Delete parent (CASCADE deletes stock_order_lines)
    await trx.deleteFrom("stock_orders").where("id", "=", id).where("franchise_id", "=", ctx.franchiseId).execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "stock_order",
      entityId: id,
      beforeState: fullOrder,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 9. STOCK ACCOUNT PAYMENTS
// ===========================================================================

export async function listStockAccountPayments(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("stock_account_payments")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getStockAccountPayment(franchiseId: string, id: string) {
  return db
    .selectFrom("stock_account_payments")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createStockAccountPayment(ctx: MutationContext, data: StockAccountPaymentCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    const account = await trx
      .selectFrom("stock_accounts")
      .select(["id"])
      .where("id", "=", data.account_id)
      .where("franchise_id", "=", ctx.franchiseId)
      .executeTakeFirst();

    if (!account) {
      throw new InvalidReferenceError("Referenced stock account does not exist in this franchise.");
    }

    const created = await trx
      .insertInto("stock_account_payments")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        account_id: data.account_id,
        amount: data.amount,
        payment_method: data.payment_method,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "stock_account_payment",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateStockAccountPayment(ctx: MutationContext, id: string, data: StockAccountPaymentUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM stock_account_payments
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Stock account payment not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    if (data.account_id && data.account_id !== item.account_id) {
      const account = await trx
        .selectFrom("stock_accounts")
        .select(["id"])
        .where("id", "=", data.account_id)
        .where("franchise_id", "=", ctx.franchiseId)
        .executeTakeFirst();

      if (!account) {
        throw new InvalidReferenceError("Referenced stock account does not exist in this franchise.");
      }
    }

    const updated = await trx
      .updateTable("stock_account_payments")
      .set({
        account_id: data.account_id !== undefined ? data.account_id : item.account_id,
        amount: data.amount !== undefined ? data.amount : item.amount,
        payment_method: data.payment_method !== undefined ? data.payment_method : item.payment_method,
        notes: data.notes !== undefined ? data.notes : item.notes,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "stock_account_payment",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteStockAccountPayment(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM stock_account_payments
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Stock account payment not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("stock_account_payments")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "stock_account_payment",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}

// ===========================================================================
// 10. JAZZ COMPANY PAYABLE PAYMENTS
// ===========================================================================

export async function listJazzPayablePayments(franchiseId: string, filter: TransactionFilter) {
  let q = db
    .selectFrom("jazz_company_payable_payments")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(filter.limit)
    .offset(filter.offset);

  if (filter.day_id) {
    q = q.where("day_id", "=", filter.day_id);
  }

  return q.execute();
}

export async function getJazzPayablePayment(franchiseId: string, id: string) {
  return db
    .selectFrom("jazz_company_payable_payments")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createJazzPayablePayment(ctx: MutationContext, data: JazzPayablePaymentCreate) {
  return db.transaction().execute(async (trx) => {
    await assertAccountingDayActive(trx, ctx.franchiseId, data.day_id);

    const created = await trx
      .insertInto("jazz_company_payable_payments")
      .values({
        franchise_id: ctx.franchiseId,
        day_id: data.day_id,
        amount: data.amount,
        payment_reference: data.payment_reference ?? null,
        notes: data.notes ?? null,
        created_by_user_id: ctx.userId
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "CREATE",
      entityType: "jazz_company_payable_payment",
      entityId: created.id,
      afterState: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return created;
  });
}

export async function updateJazzPayablePayment(ctx: MutationContext, id: string, data: JazzPayablePaymentUpdate) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_company_payable_payments
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Company payable payment not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    const updated = await trx
      .updateTable("jazz_company_payable_payments")
      .set({
        amount: data.amount !== undefined ? data.amount : item.amount,
        payment_reference: data.payment_reference !== undefined ? data.payment_reference : item.payment_reference,
        notes: data.notes !== undefined ? data.notes : item.notes,
        revision: (item.revision || 1) + 1
      })
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .returningAll()
      .executeTakeFirstOrThrow();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "UPDATE",
      entityType: "jazz_company_payable_payment",
      entityId: id,
      beforeState: item,
      afterState: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return updated;
  });
}

export async function deleteJazzPayablePayment(ctx: MutationContext, id: string) {
  return db.transaction().execute(async (trx) => {
    const existing = await sql<any>`
      SELECT * FROM jazz_company_payable_payments
      WHERE id = ${id} AND franchise_id = ${ctx.franchiseId}
      FOR UPDATE;
    `.execute(trx);

    if (existing.rows.length === 0) {
      throw new NotFoundError("Jazz Company payable payment not found.");
    }
    const item = existing.rows[0];

    await assertAccountingDayActive(trx, ctx.franchiseId, item.day_id);

    await trx
      .deleteFrom("jazz_company_payable_payments")
      .where("id", "=", id)
      .where("franchise_id", "=", ctx.franchiseId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId: ctx.franchiseId,
      userId: ctx.userId,
      userEmail: ctx.userEmail,
      action: "DELETE",
      entityType: "jazz_company_payable_payment",
      entityId: id,
      beforeState: item,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    });

    return { success: true, id };
  });
}
