import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentMultipleTabManager
} from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? ""
};

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean);
const firestoreCacheMode = import.meta.env.VITE_FIRESTORE_CACHE_MODE ?? (import.meta.env.DEV ? "memory" : "persistent");
const forceLongPolling = (import.meta.env.VITE_FIRESTORE_FORCE_LONG_POLLING ?? (import.meta.env.DEV ? "true" : "false")) === "true";

export const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app
  ? initializeFirestore(app, {
      experimentalForceLongPolling: forceLongPolling,
      // Production uses IndexedDB persistence for shop-machine offline work.
      // Local dev defaults to memory cache because Vite HMR can leave Firestore's persistent watch state corrupted.
      localCache:
        firestoreCacheMode === "persistent"
          ? persistentLocalCache({ tabManager: persistentMultipleTabManager() })
          : memoryLocalCache()
    })
  : null;
export const functions = app ? getFunctions(app) : null;
