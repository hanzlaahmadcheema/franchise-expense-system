const admin = require("firebase-admin");

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "franchise-expense-system";

const OPENING_STOCK_BY_PRODUCT = new Map([
  ["retailer sim", 1129],
  ["franchise sim", 7],
  ["load sim", 3],
  ["data sim", 0],
  ["e sim", 15],
  ["dongle", 0],
  ["gold number", 85],
  ["retailer imzi", 1610],
  ["ccr imzi", 297]
]);

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function main() {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const productsSnap = await db.collection("stockSettings/products/items").get();
  const openingStock = {};
  const matched = [];
  const missing = [];

  for (const [productName, quantity] of OPENING_STOCK_BY_PRODUCT.entries()) {
    const productDoc = productsSnap.docs.find((doc) => normalize(doc.data().name) === productName);
    if (!productDoc) {
      missing.push(productName);
      continue;
    }
    openingStock[productDoc.id] = quantity;
    matched.push(`${productDoc.data().name}: ${quantity}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing Stock Settings products: ${missing.join(", ")}`);
  }

  await db.doc("stockSettings/opening/items/main").set({
    openingStock,
    jazzOpeningPayable: 0,
    seededAt: admin.firestore.FieldValue.serverTimestamp(),
    seedSource: "functions/scripts/seed-stock-opening.cjs"
  }, { merge: true });

  console.log(`Seeded stockSettings/opening/items/main in ${PROJECT_ID}`);
  console.log(matched.join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
