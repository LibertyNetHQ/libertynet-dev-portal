"use client";

/**
 * Session state, in React memory only.
 *
 * There is deliberately no persistence layer here — no `localStorage`, no
 * cookie, no `sessionStorage`. A refresh logs you out, which is the correct
 * trade for a bearer token: anything persisted is readable by every script on the
 * origin and survives into profile backups.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { isExpired, type Session } from "../../lib/session";

interface Ctx {
  session: Session | null;
  setSession: (s: Session | null) => void;
}

const SessionCtx = createContext<Ctx>({ session: null, setSession: () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);

  // Sessions last exactly one hour and cannot be refreshed. Drop it the moment it
  // expires rather than letting the UI show stale data behind a dead token.
  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) return setSession(null);

    const timer = setTimeout(() => setSession(null), remaining);
    return () => clearTimeout(timer);
  }, [session]);

  return (
    <SessionCtx.Provider value={{ session, setSession }}>{children}</SessionCtx.Provider>
  );
}

export function useSession() {
  const { session, setSession } = useContext(SessionCtx);
  return { session: isExpired(session) ? null : session, setSession };
}
