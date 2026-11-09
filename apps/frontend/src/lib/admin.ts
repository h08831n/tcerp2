/**
 * IAM-001 — user management + RBAC API clients.
 * Contract source of truth: apps/backend/src/users/*.controller.ts +
 * apps/backend/src/roles/*.controller.ts + /permissions catalog + /audit.
 */

import { apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";
import type { TimelineItemDto } from "@/lib/party";

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type UserStatus = "ACTIVE" | "DISABLED" | "LOCKED";

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: "فعال",
  DISABLED: "غیرفعال",
  LOCKED: "قفل‌شده",
};

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  version: number;
  companyRoles?: {
    companyId: string;
    role: { id: string; code: string; nameFa: string; nameEn?: string };
  }[];
  companies?: { id: string; nameFa: string }[];
  defaultCompanyId?: string | null;
}

export interface UserQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: UserStatus | "";
}

export function fetchUsersAdmin(query: UserQuery = {}): Promise<PaginatedResponse<UserRow>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  return apiJson<PaginatedResponse<UserRow>>(`/users?${params.toString()}`);
}

export function fetchUser(id: string): Promise<UserRow> {
  return apiJson<UserRow>(`/users/${id}`);
}

export interface CreateUserBody {
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
}

export function createUser(body: CreateUserBody): Promise<UserRow> {
  return apiJson<UserRow>("/users", { method: "POST", body: JSON.stringify(body) });
}

export interface UpdateUserBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  mobile?: string;
  status?: UserStatus;
  version: number;
}

export function updateUser(id: string, body: UpdateUserBody): Promise<UserRow> {
  return apiJson<UserRow>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function resetUserPassword(id: string, newPassword: string): Promise<{ success?: boolean }> {
  return apiJson(`/users/${id}/password`, {
    method: "POST",
    body: JSON.stringify({ password: newPassword }),
  });
}

/** Replace the user's roles within one company (backend: PUT /users/:id/companies/:companyId/roles). */
export function setUserCompanyRoles(
  id: string,
  companyId: string,
  roleIds: string[],
): Promise<UserRow> {
  return apiJson(`/users/${id}/companies/${companyId}/roles`, {
    method: "PUT",
    body: JSON.stringify({ roleIds }),
  });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface RoleRow {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  isSystem: boolean;
  active: boolean;
  createdAt: string;
  users?: unknown[];
  permissions?: { permission: { id: string; code: string; module: string; action: string } }[];
}

export function fetchRoles(query: { search?: string; page?: number; pageSize?: number } = {}): Promise<
  PaginatedResponse<RoleRow>
> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 100));
  if (query.search) params.set("search", query.search);
  return apiJson<PaginatedResponse<RoleRow>>(`/roles?${params.toString()}`);
}

export function fetchRole(id: string): Promise<RoleRow> {
  return apiJson<RoleRow>(`/roles/${id}`);
}

export function createRole(body: { code: string; nameFa: string; nameEn?: string }): Promise<RoleRow> {
  return apiJson<RoleRow>("/roles", { method: "POST", body: JSON.stringify(body) });
}

export function updateRole(
  id: string,
  body: { nameFa?: string; nameEn?: string; active?: boolean },
): Promise<RoleRow> {
  return apiJson<RoleRow>(`/roles/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteRole(id: string): Promise<void> {
  return apiJson<void>(`/roles/${id}`, { method: "DELETE" });
}

export function setRolePermissions(id: string, permissionIds: string[]): Promise<RoleRow> {
  return apiJson<RoleRow>(`/roles/${id}/permissions`, {
    method: "PUT",
    body: JSON.stringify({ permissionIds }),
  });
}

// ---------------------------------------------------------------------------
// Permission catalog (grouped by module for the matrix UI)
// ---------------------------------------------------------------------------

export interface PermissionRow {
  id: string;
  code: string;
  module: string;
  action: string;
  description: string | null;
}

export function fetchPermissionCatalog(): Promise<PermissionRow[]> {
  // GET /permissions returns {items, total} (paginated envelope).
  return apiJson<{ items: PermissionRow[]; total: number }>("/permissions").then(
    (res) => res.items ?? [],
  );
}

// ---------------------------------------------------------------------------
// Security audit log
// ---------------------------------------------------------------------------

export interface SecurityAuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** Security-relevant audit actions (IAM-001 §16). */
export const SECURITY_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "PASSWORD_RESET",
  "ROLE_ASSIGNED",
  "ROLE_REMOVED",
  "ROLES_CHANGED",
  "PERMISSIONS_CHANGED",
  "OVERRIDE",
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
] as const;

export function fetchSecurityAudit(
  query: { page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<SecurityAuditRow>> {
  // The /audit endpoint filters by action (single value) — fetch broadly and
  // filter client-side across the security action set (50 rows/page).
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 50));
  return apiJson<PaginatedResponse<SecurityAuditRow>>(`/audit?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// CORE-003 — settings center
// ---------------------------------------------------------------------------

export interface SettingCatalogEntry {
  key: string;
  category: string;
  type: "number" | "string" | "boolean" | "select";
  labelFa: string;
  descriptionFa: string;
  options: string[] | null;
  consumer: string;
  value: unknown;
  isSecret: boolean;
  isOverridden: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  defaultValue: unknown;
}

export function fetchSettingsCatalog(): Promise<SettingCatalogEntry[]> {
  return apiJson<SettingCatalogEntry[]>("/settings/catalog");
}

export function saveSetting(key: string, value: unknown): Promise<unknown> {
  return apiJson(`/settings/catalog/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export function restoreSettingDefault(key: string): Promise<{ key: string; restored: boolean }> {
  return apiJson(`/settings/catalog/${key}`, { method: "DELETE" });
}
