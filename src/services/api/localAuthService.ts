/**
 * Local Authentication Service (Phase 13)
 * 
 * Provides username/password authentication against backend `/api/v1/auth`:
 * - login
 * - logout
 * - session verification across reloads
 * - auth token injection into ledgerApiClient
 */

import { apiRequest, ApiError, setAuthTokenProvider } from "./ledgerApiClient";
import type { UserRole } from "../../types/ledger";

const LOCAL_SESSION_TOKEN_KEY = "franchise_local_session_token";
const LOCAL_USER_CACHE_KEY = "franchise_local_user";

export interface LocalUser {
  id: string;
  username: string;
  email?: string | null;
  displayName: string | null;
  role: UserRole;
}

export interface LocalFranchise {
  id: string;
  code: string;
  name: string;
  brandName: string;
  role: UserRole;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: LocalUser;
  franchise: LocalFranchise;
}

export interface AuthMeResponse {
  user: LocalUser;
  franchise?: LocalFranchise;
}

class LocalAuthService {
  private currentToken: string | null = null;
  private currentUser: LocalUser | null = null;
  private currentFranchise: LocalFranchise | null = null;

  constructor() {
    this.currentToken = typeof window !== "undefined" && typeof window.localStorage !== "undefined" && window.localStorage ? window.localStorage.getItem(LOCAL_SESSION_TOKEN_KEY) : null;
    if (this.currentToken) {
      setAuthTokenProvider(async () => this.currentToken);
    }
  }

  getToken(): string | null {
    return this.currentToken;
  }

  getUser(): LocalUser | null {
    return this.currentUser;
  }

  getFranchise(): LocalFranchise | null {
    return this.currentFranchise;
  }

  async login(username: string, password: string): Promise<{ user: LocalUser; franchise: LocalFranchise }> {
    const res = await apiRequest<LoginResponse>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    this.currentToken = res.token;
    this.currentUser = res.user;
    this.currentFranchise = res.franchise;

    localStorage.setItem(LOCAL_SESSION_TOKEN_KEY, res.token);
    localStorage.setItem(LOCAL_USER_CACHE_KEY, JSON.stringify({ user: res.user, franchise: res.franchise }));
    setAuthTokenProvider(async () => res.token);

    return { user: res.user, franchise: res.franchise };
  }

  async logout(): Promise<void> {
    try {
      if (this.currentToken) {
        await apiRequest("/api/v1/auth/logout", { method: "POST" });
      }
    } catch {
      // Ignore network errors on logout
    } finally {
      this.currentToken = null;
      this.currentUser = null;
      this.currentFranchise = null;
      localStorage.removeItem(LOCAL_SESSION_TOKEN_KEY);
      localStorage.removeItem(LOCAL_USER_CACHE_KEY);
      setAuthTokenProvider(null);
    }
  }

  async restoreSession(): Promise<{ user: LocalUser; franchise?: LocalFranchise } | null> {
    const token = localStorage.getItem(LOCAL_SESSION_TOKEN_KEY);
    if (!token) {
      this.currentToken = null;
      this.currentUser = null;
      this.currentFranchise = null;
      setAuthTokenProvider(null);
      return null;
    }

    this.currentToken = token;
    setAuthTokenProvider(async () => token);

    try {
      const res = await apiRequest<AuthMeResponse>("/api/v1/auth/me", { method: "GET" });
      this.currentUser = res.user;
      this.currentFranchise = res.franchise ?? null;
      localStorage.setItem(LOCAL_USER_CACHE_KEY, JSON.stringify({ user: res.user, franchise: res.franchise }));
      return { user: res.user, franchise: res.franchise };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        // Session expired or revoked
        this.currentToken = null;
        this.currentUser = null;
        this.currentFranchise = null;
        localStorage.removeItem(LOCAL_SESSION_TOKEN_KEY);
        localStorage.removeItem(LOCAL_USER_CACHE_KEY);
        setAuthTokenProvider(null);
        return null;
      }

      // Offline resilience: if backend is unreachable, load cached user
      const cached = localStorage.getItem(LOCAL_USER_CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          this.currentUser = parsed.user;
          this.currentFranchise = parsed.franchise;
          return { user: parsed.user, franchise: parsed.franchise };
        } catch {
          // Fall through
        }
      }

      throw err;
    }
  }
}

export const localAuthService = new LocalAuthService();
