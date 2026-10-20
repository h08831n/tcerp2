"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api";

export interface AuthUser {
  id: string | number;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  [key: string]: unknown;
}

export interface AuthContextValue {
  user: AuthUser | null;
  permissions: string[];
  loading: boolean;
  /** Fetches GET /auth/me; returns true when a user is authenticated. */
  refresh: () => Promise<boolean>;
  /** Calls POST /auth/logout and clears local state (errors ignored). */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const response = await apiFetch("/auth/me");
      const data = (await response.json()) as {
        id?: AuthUser["id"];
        username?: string;
        permissions?: unknown;
      } & Partial<AuthUser>;
      // /auth/me contract (Phase 1+2, unchanged): the profile comes back FLAT —
      // {id, username, ..., permissions, companies, defaultCompanyId} — with NO
      // {user: ...} wrapper. Reading data.user left `user` permanently null and
      // bounced every authenticated route back to /login (browser smoke test).
      if (data.id && data.username) {
        setUser(data as AuthUser);
        setPermissions(
          Array.isArray(data.permissions) ? (data.permissions as string[]) : [],
        );
        return true;
      }
      setUser(null);
      setPermissions([]);
      return false;
    } catch {
      setUser(null);
      setPermissions([]);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      // even if the request fails, clear local state
    }
    setUser(null);
    setPermissions([]);
  }, []);

  const value = useMemo(
    () => ({ user, permissions, loading, refresh, logout }),
    [user, permissions, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
