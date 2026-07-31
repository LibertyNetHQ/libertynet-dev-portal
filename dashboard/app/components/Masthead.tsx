"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSession } from "./SessionProvider";
import { LivingMark } from "./LivingMark";
import { minutesRemaining } from "../../lib/session";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/network", label: "Network" },
  { href: "/nodes", label: "My nodes" },
  { href: "/credits", label: "Credits" },
];

export function Masthead() {
  const pathname = usePathname();
  const { session, setSession } = useSession();

  return (
    <header className="masthead">
      <LivingMark />
      <h1>
        Liberty<b>Net</b> <span className="muted small">Developer Dashboard</span>
      </h1>

      <nav>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}

        {session ? (
          <button
            className="btn"
            style={{ padding: "6px 12px", fontSize: 13 }}
            onClick={() => setSession(null)}
            title={`Session expires in ${minutesRemaining(session)} min`}
          >
            Sign out · {minutesRemaining(session)}m
          </button>
        ) : (
          <Link href="/login" aria-current={pathname === "/login" ? "page" : undefined}>
            Sign in
          </Link>
        )}
      </nav>
    </header>
  );
}
