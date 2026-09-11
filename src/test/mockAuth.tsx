/** Demo/test auth: always an approved admin. */
import type { ReactNode } from "react";
export function AuthProvider({ children }: { children: ReactNode }) { return <>{children}</>; }
export function useAuth() {
  return { loading: false, session: { user: { id: "demo", email: "owner@demo.local" } } as never, isAdmin: true, adminName: "Demo Owner", signIn: async () => null, signOut: async () => {} };
}
