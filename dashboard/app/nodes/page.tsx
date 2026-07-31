"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchMyNodes, type BoundNode } from "../../lib/libertynet";
import { useSession } from "../components/SessionProvider";

export default function MyNodes() {
  const { session } = useSession();
  const [nodes, setNodes] = useState<BoundNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    fetchMyNodes(session.token)
      .then((r) => setNodes(r.nodes))
      .catch((e) => setError(String(e.message ?? e)));
  }, [session]);

  if (!session) {
    return (
      <>
        <h2>My nodes</h2>
        <p className="lead">Sign in to see the nodes bound to your operator identity.</p>
        <Link className="btn primary" href="/login">
          Sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <h2>My nodes</h2>
      <p className="lead">
        Nodes bound to <span className="mono">{session.operatorDid}</span>, with the limits
        agreed when each binding was activated.
      </p>

      {error && (
        <div className="notice fault">
          <strong>Could not read your nodes.</strong> {error}
        </div>
      )}

      {nodes && nodes.length === 0 && (
        <div className="card">
          <h3>No nodes bound yet</h3>
          <p className="small muted">
            Binding is a four-signature handshake where both the node and you must consent.
            It happens in the Operator Console, not here — this dashboard deliberately does
            not reimplement the signing involved.
          </p>
          <a className="btn" href="https://docs.libertynet.ai/concepts/binding">
            How binding works
          </a>
        </div>
      )}

      {nodes && nodes.length > 0 && (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>State</th>
                  <th>Node</th>
                  <th>Region</th>
                  <th>Capabilities</th>
                  <th>Task types</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.node_did}>
                    <td>
                      <span className={n.online ? "pill live" : "pill idle"}>
                        {n.online ? "Online" : "Offline"}
                      </span>
                    </td>
                    <td className="mono">{n.node_did}</td>
                    <td>{n.region ?? <span className="muted">—</span>}</td>
                    <td className="small">
                      {n.capabilities.length ? n.capabilities.join(", ") : <span className="muted">—</span>}
                    </td>
                    <td className="small">
                      {n.authorization.task_types?.length ? (
                        n.authorization.task_types.join(", ")
                      ) : (
                        <span className="muted">any</span>
                      )}
                    </td>
                    <td className="mono">{n.last_seen ?? "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="notice">
        <strong>The registry resolves two DID spellings for you here.</strong> A binding is
        stored under the node&apos;s short <code>did:svrp:n:&lt;8hex&gt;</code> form, while a
        running daemon announces itself as <code>did:svrp:&lt;64hex&gt;</code>. Same key, two
        encodings — comparing the strings would split one node into two.{" "}
        <a href="https://docs.libertynet.ai/concepts/identity#two-encodings-one-identity">
          Why
        </a>
        .
      </div>
    </>
  );
}
