import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import * as fs from "node:fs";
import { env } from "../config/env.js";
import type { DecodedIdToken } from "./types.js";

let firebaseAdminApp: App | null = null;
let mockTokenVerifier: ((token: string) => Promise<DecodedIdToken>) | null = null;

/**
 * Initializes the Firebase Admin SDK based on environment configuration.
 * Supports:
 * 1. Service Account JSON file path
 * 2. Environment variables (Project ID, Client Email, Private Key with escaped newlines)
 * 3. Firebase Auth Emulator
 * 4. Application Default Credentials (GCP/Cloud Run)
 */
function initFirebaseAdmin(): App | null {
  const existingApps = getApps();
  if (existingApps.length > 0 && existingApps[0]) {
    return existingApps[0];
  }

  // Check Auth Emulator configuration
  if (env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = env.FIREBASE_AUTH_EMULATOR_HOST;
  }

  try {
    // Option 1: File path
    if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      if (fs.existsSync(env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
        const fileContent = fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf-8");
        const serviceAccount = JSON.parse(fileContent);
        return initializeApp({
          credential: cert(serviceAccount)
        });
      } else {
        console.warn(
          `[Firebase Admin] Specified FIREBASE_SERVICE_ACCOUNT_PATH does not exist: ${env.FIREBASE_SERVICE_ACCOUNT_PATH}`
        );
      }
    }

    // Option 2: Individual credentials
    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
      const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
      return initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey
        })
      });
    }

    // Option 3: Project ID only (e.g. for emulator or GCP environment)
    if (env.FIREBASE_PROJECT_ID) {
      return initializeApp({
        projectId: env.FIREBASE_PROJECT_ID
      });
    }

    return null;
  } catch (err) {
    console.error(
      "[Firebase Admin Initialization Error]",
      err instanceof Error ? err.message : "Failed to initialize Firebase Admin SDK"
    );
    return null;
  }
}

firebaseAdminApp = initFirebaseAdmin();

export function isFirebaseAdminInitialized(): boolean {
  return Boolean(firebaseAdminApp || mockTokenVerifier);
}

/**
 * Sets a custom token verifier for testing/mocking purposes.
 * Pass null to restore default Firebase Admin verification.
 */
export function setTokenVerifierForTesting(
  verifier: ((token: string) => Promise<DecodedIdToken>) | null
): void {
  mockTokenVerifier = verifier;
}

/**
 * Verifies a Firebase ID token.
 * Throws a sanitized Error if the token is invalid, expired, or admin is unconfigured.
 */
export async function verifyFirebaseIdToken(token: string): Promise<DecodedIdToken> {
  // If test verifier is registered, prioritize it
  if (mockTokenVerifier) {
    return mockTokenVerifier(token);
  }

  if (!firebaseAdminApp) {
    throw new Error("FIREBASE_ADMIN_NOT_CONFIGURED");
  }

  try {
    const decoded = await getAuth(firebaseAdminApp).verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email,
      email_verified: decoded.email_verified,
      name: decoded.name,
      picture: decoded.picture,
      auth_time: decoded.auth_time
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Token verification failed";
    if (message.includes("expired")) {
      throw new Error("TOKEN_EXPIRED");
    }
    throw new Error("TOKEN_INVALID");
  }
}
