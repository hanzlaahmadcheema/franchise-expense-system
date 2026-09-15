import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "./types.js";

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 1,
  admin: 2,
  owner: 3
};

/**
 * Checks if a current user role satisfies the required minimum role.
 * Hierarchy: owner (3) > admin (2) > viewer (1)
 */
export function hasRequiredRole(currentRole: UserRole, requiredRole: UserRole): boolean {
  return (ROLE_RANK[currentRole] ?? 0) >= (ROLE_RANK[requiredRole] ?? 0);
}

/**
 * requireRole Middleware
 * 
 * Enforces role authorization within the authenticated franchise context.
 * Must run after requireAuth and requireFranchise.
 */
export function requireRole(requiredRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !req.auth.franchise) {
      res.status(403).json({
        error: "FRANCHISE_CONTEXT_REQUIRED",
        message: "Franchise membership context is required for role validation."
      });
      return;
    }

    const currentRole = req.auth.franchise.role;

    if (!hasRequiredRole(currentRole, requiredRole)) {
      res.status(403).json({
        error: "INSUFFICIENT_ROLE",
        message: `Operation requires '${requiredRole}' role or higher. Current role: '${currentRole}'.`
      });
      return;
    }

    next();
  };
}
