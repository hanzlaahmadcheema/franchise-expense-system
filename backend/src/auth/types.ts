/**
 * Authentication and Tenancy Type Definitions
 */

export type UserRole = "owner" | "admin" | "viewer";

export interface DecodedIdToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  auth_time?: number;
  [key: string]: unknown;
}

export interface AuthenticatedUser {
  id: string;
  firebaseUid?: string | null;
  username?: string | null;
  email: string | null;
  displayName: string | null;
  isActive: boolean;
}

export interface FranchiseContext {
  id: string;
  code: string;
  name: string;
  brandName: string;
  role: UserRole;
}

export interface UserFranchiseMembership {
  id: string;
  code: string;
  name: string;
  brandName: string;
  role: UserRole;
}

export interface AuthContext {
  firebaseUid?: string | null;
  user: AuthenticatedUser;
  token?: string;
  franchise?: FranchiseContext;
  availableFranchises?: UserFranchiseMembership[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
