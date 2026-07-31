"use client";

/**
 * The Credits page.
 *
 * The whole reason this page is careful: the endpoint returns `200` with a
 * JSON body that looks exactly like a balance, and every number in it is `0`.
 * Rendering those zeros next to the word "earnings" would be a lie told through a
 * number — so when `source` is `not_yet_wired`, this page shows the caveat and
 * greys the figures rather than presenting them as measurements.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchCredits, type CreditsBalance } from "../../lib/libertynet";
import { useSession } from "../components/SessionProvider";

export default function Credits() {
  const { session } = useSession();
  const [balance, setBalance] = useState<CreditsBalance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    fetchCredits(session.token)
      .then(setBalance)
      .catch((e) => setError(String(e.message ?? e)));
  }, [session]);

  if (!session) {
    return (
      <>
        <h2>Credits</h2>
        <p className="lead">Sign in to read the credits endpoint for your operator identity.</p>
        <Link className="btn primary" href="/login">
          Sign in
        </Link>
      </>
    );
  }

  const wired = balance?.source === "ledger";

  return (
    <>
      <h2>Credits</h2>
      <p className="lead">
        Credits are a <strong>test unit</strong> — not cash, not redeemable, and not a claim
        on future value.
      </p>

      {balance && !wired && (
        <div className="notice">
          <strong>Nothing is counting yet.</strong> This endpoint is live and returns{" "}
          <code>200</code>, but no credits ledger is connected to it —{" "}
          <code className="mono">source: &quot;not_yet_wired&quot;</code>.
          <br />
          <br />
          The zeros below are placeholders, not measurements. They mean{" "}
          <em>nothing is being counted</em>, which is a different statement from{" "}
          <em>you earned nothing</em>.
        </div>
      )}

      {error && (
        <div className="notice fault">
          <strong>Could not read credits.</strong> {error}
        </div>
      )}

      {balance && (
        <>
          <div className="grid">
            {(["settled", "pending", "estimated"] as const).map((bucket) => (
              <div key={bucket} className="stat">
                <div className="n" style={{ color: wired ? "var(--cyan)" : "var(--muted)" }}>
                  {wired ? balance[bucket].amount : "—"}
                </div>
                <div className="k">{bucket}</div>
                <div className="note">
                  {wired
                    ? balance[bucket].meaning
                    : `Reported as ${balance[bucket].amount}, but not measured.`}
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Why three numbers, never one</h3>
            <table>
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Means</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>settled</td>
                  <td>Confirmed by evidence verification and settlement. The real one.</td>
                </tr>
                <tr>
                  <td>pending</td>
                  <td>Submitted, not yet verified. May never settle. Do not spend it.</td>
                </tr>
                <tr>
                  <td>estimated</td>
                  <td>A beta model&apos;s guess. Not a commitment and not a forecast.</td>
                </tr>
              </tbody>
            </table>
            <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
              A UI that adds these together and shows one figure misrepresents all three.
            </p>
          </div>

          <div className="card">
            <h3>Raw response</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              Exactly what the endpoint returned, so you can check this page against it.
            </p>
            <div className="table-wrap">
              <pre className="mono small" style={{ margin: 0, color: "var(--muted)" }}>
                {JSON.stringify(balance, null, 2)}
              </pre>
            </div>
          </div>
        </>
      )}

      <p className="small muted">
        <a href="https://docs.libertynet.ai/concepts/credits">What Credits are and are not →</a>
      </p>
    </>
  );
}
