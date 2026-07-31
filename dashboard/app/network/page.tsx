"use client";

import { useEffect, useState } from "react";

import { fetchNodes, fingerprint, type Audit } from "../../lib/libertynet";

export default function Network() {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlineOnly, setOnlineOnly] = useState(false);

  useEffect(() => {
    const load = () => fetchNodes().then(setAudit).catch((e) => setError(String(e.message ?? e)));
    load();
    // 30s, not 1s. The registry is a shared public resource with no rate limit
    // you had to apply for — treat that as a responsibility.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  const rows = (audit?.verified ?? []).filter((n) => !onlineOnly || n.online);

  return (
    <>
      <h2>Network</h2>
      <p className="lead">
        Every node the registry knows about. Each identity was verified in your browser
        before it was drawn — a record that failed would appear below in red, not silently
        disappear.
      </p>

      {error && (
        <div className="notice fault">
          <strong>Could not reach the registry.</strong> {error}
        </div>
      )}

      {audit && audit.rejected.length > 0 && (
        <div className="notice fault">
          <strong>{audit.rejected.length} records failed id-binding.</strong>
          <ul className="mono small">
            {audit.rejected.map((n) => (
              <li key={n.did}>{n.did}</li>
            ))}
          </ul>
          Their DIDs do not derive from the keys served with them. Please report this.
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <label style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={onlineOnly}
              onChange={(e) => setOnlineOnly(e.target.checked)}
              style={{ width: "auto" }}
            />
            Online only
          </label>
          <span className="small muted">
            {rows.length} shown · {audit?.verified.length ?? 0} verified · {audit?.total ?? 0}{" "}
            registered · refreshes every 30s
          </span>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>DID</th>
                <th>Fingerprint</th>
                <th>Region</th>
                <th>Capabilities</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.did}>
                  <td>
                    <span className={n.online ? "pill live" : "pill idle"}>
                      {n.online ? "Online" : "Stale"}
                    </span>
                  </td>
                  <td className="mono">{n.did}</td>
                  <td className="mono">{fingerprint(n.public_key)}</td>
                  <td>{n.region ?? <span className="muted">—</span>}</td>
                  <td className="small">
                    {n.capabilities.length ? n.capabilities.join(", ") : <span className="muted">—</span>}
                  </td>
                  <td className="mono">{n.last_seen ?? "never"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted small">
                    {audit ? "No nodes match." : "Loading…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="notice">
        <strong>&quot;Stale&quot; is not the same as the record&apos;s own status field.</strong>{" "}
        Most rows above say <code>status: &quot;active&quot;</code> in the raw data, including
        ones last seen weeks ago — nothing ever clears it. The state shown here is computed
        from <code>last_seen</code>, which is the only field that decays.
      </div>
    </>
  );
}
