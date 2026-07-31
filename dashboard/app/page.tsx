"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchNodes, type Audit } from "../lib/libertynet";
import { useSession } from "./components/SessionProvider";

export default function Overview() {
  const { session } = useSession();
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchNodes()
      .then(setAudit)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const online = audit?.verified.filter((n) => n.online).length ?? 0;

  return (
    <>
      <h2>Overview</h2>
      <p className="lead">
        The live network and your operator account. Every identity below was verified in
        your own browser — nothing on this page was taken on trust from the server that
        served it.
      </p>

      {error && (
        <div className="notice fault">
          <strong>Could not reach the registry.</strong> {error}
        </div>
      )}

      <div className="grid">
        <div className="stat">
          <div className="n">{audit ? audit.total : "—"}</div>
          <div className="k">Registered</div>
          <div className="note">Includes nodes that stopped reporting long ago.</div>
        </div>

        <div className="stat is-live">
          <div className="n">{audit ? audit.verified.length : "—"}</div>
          <div className="k">Verified</div>
          <div className="note">DID derives from the public key.</div>
        </div>

        <div className="stat is-live">
          <div className="n">{audit ? online : "—"}</div>
          <div className="k">Online now</div>
          <div className="note">Seen in the last 10 minutes.</div>
        </div>

        <div className={audit && audit.rejected.length > 0 ? "stat is-fault" : "stat"}>
          <div className="n">{audit ? audit.rejected.length : "—"}</div>
          <div className="k">Failed verification</div>
          <div className="note">
            {audit && audit.rejected.length > 0
              ? "Investigate — this should always be zero."
              : "Expected: zero."}
          </div>
        </div>
      </div>

      {audit && audit.rejected.length > 0 && (
        <div className="notice fault" style={{ marginTop: 16 }}>
          <strong>{audit.rejected.length} records failed id-binding.</strong> Their DIDs do
          not derive from the public keys served alongside them. That is either corruption
          or forgery, and it is worth reporting rather than ignoring. See{" "}
          <Link href="/network">Network</Link>.
        </div>
      )}

      <div className="card" style={{ marginTop: 24 }}>
        <h3>Your account</h3>
        {session ? (
          <>
            <p className="small mono muted" style={{ marginTop: 0 }}>
              {session.operatorDid}
            </p>
            <p className="small muted">
              Signed in. The session token is held in memory only and expires within the
              hour — a refresh will sign you out, on purpose.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <Link className="btn" href="/nodes">
                My nodes
              </Link>
              <Link className="btn" href="/credits">
                Credits
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              Not signed in. Everything above is public and needs no account — signing in
              only adds the view of nodes bound to you.
            </p>
            <Link className="btn primary" href="/login">
              Sign in
            </Link>
          </>
        )}
      </div>

      <div className="card">
        <h3>What is actually built</h3>
        <table>
          <tbody>
            <tr>
              <td>Discovery · identity · binding</td>
              <td>
                <span className="pill live">Implemented</span>
              </td>
            </tr>
            <tr>
              <td>Credits · evidence</td>
              <td>
                <span className="pill partial">Not yet wired</span>
              </td>
            </tr>
            <tr>
              <td>Oracle contracts</td>
              <td>
                <span className="pill partial">Testing</span>
              </td>
            </tr>
            <tr>
              <td>Wallet · DEX · token</td>
              <td>
                <span className="pill idle">Planned</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
          No endpoint in this API moves value.{" "}
          <a href="https://docs.libertynet.ai/status">Full capability matrix →</a>
        </p>
      </div>
    </>
  );
}
