"use client";

/**
 * Operator sign-in.
 *
 * The private key is pasted, used once to sign a single challenge, and zeroed.
 * It is never transmitted, never stored, and never included in an error message —
 * a key in a stack trace is a key in your error reporter.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { attemptsRemaining, login, type DeviceCredential } from "../../lib/session";
import { useSession } from "../components/SessionProvider";

export default function Login() {
  const router = useRouter();
  const { setSession } = useSession();

  const [credentialJson, setCredentialJson] = useState("");
  const [secretHex, setSecretHex] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      let credential: DeviceCredential;
      try {
        credential = JSON.parse(credentialJson);
      } catch {
        throw new Error("The device credential is not valid JSON.");
      }

      const clean = secretHex.trim().replace(/\s+/g, "");
      if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
        throw new Error("The device key must be 64 hex characters (32 bytes).");
      }

      const secret = new Uint8Array(32);
      for (let i = 0; i < 32; i++) secret[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);

      const session = await login(credential, secret);

      // Clear the inputs immediately — the key should not sit in a DOM node, or
      // in a form the browser might offer to restore.
      setSecretHex("");
      setCredentialJson("");

      setSession(session);
      router.push("/");
    } catch (err) {
      // Deliberately only the message. Never the key, never the credential.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Sign in</h2>
      <p className="lead">
        There is no password here. You prove who you are by signing a single-use challenge
        with your device key — so there is nothing to phish, nothing to stuff, and nothing
        worth stealing from the registry&apos;s database.
      </p>

      <div className="notice">
        <strong>Your key never leaves this browser.</strong> It is used once to sign one
        challenge and zeroed immediately. It is not transmitted, not stored, and not written
        to any log. The resulting session lives in memory only and expires within the hour —
        which means a page refresh signs you out, on purpose.
      </div>

      <form className="card" onSubmit={submit}>
        <label htmlFor="cred">Device credential (JSON)</label>
        <textarea
          id="cred"
          value={credentialJson}
          onChange={(e) => setCredentialJson(e.target.value)}
          placeholder='{"credential_id": "...", "operator_did": "did:svrp:o:...", ...}'
          spellCheck={false}
          autoComplete="off"
          required
        />

        <label htmlFor="key">Device private key (64 hex characters)</label>
        <input
          id="key"
          type="password"
          className="mono"
          value={secretHex}
          onChange={(e) => setSecretHex(e.target.value)}
          placeholder="Paste from your keychain — never from a file in a repository"
          spellCheck={false}
          autoComplete="off"
          required
        />

        {error && (
          <div className="notice fault" style={{ marginTop: 16, marginBottom: 0 }}>
            <strong>Sign-in failed.</strong> {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18, flexWrap: "wrap" }}>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Signing…" : "Sign challenge"}
          </button>
          <span className="small muted">{attemptsRemaining()} attempts remaining</span>
        </div>
      </form>

      <div className="card">
        <h3>What happens when you press that</h3>
        <ol className="small muted" style={{ marginTop: 0, paddingLeft: 20 }}>
          <li>
            Your credential is checked locally: does its <code>operator_root_public_key</code>{" "}
            actually derive its <code>operator_did</code>? If not, nothing is signed.
          </li>
          <li>A single-use challenge is fetched from the registry. It lives 300 seconds.</li>
          <li>Your device key signs the canonical challenge bytes, in this tab.</li>
          <li>The signature is exchanged for a one-hour session token.</li>
          <li>Your key is zeroed.</li>
        </ol>
        <p className="small muted" style={{ marginBottom: 0 }}>
          <a href="https://docs.libertynet.ai/guides/operator-login">The full flow →</a>
        </p>
      </div>

      <div className="notice">
        <strong>Where the key should come from.</strong> Your OS keychain or a secret
        manager. Never a file in a repository, never a <code>.env</code>, never your shell
        history. If you do not have a device credential yet, the Operator Console creates
        one — your root key signs it once, offline, and then goes back in the safe.
      </div>
    </>
  );
}
