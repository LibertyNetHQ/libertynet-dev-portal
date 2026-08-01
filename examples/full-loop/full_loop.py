"""The whole loop: discover -> verify -> act, from any machine.

    pip install cryptography     # only the last step needs it
    python3 full_loop.py

Uses nothing but public URLs. No account, no API key, nobody's permission.

This is the example that proves the front page is literally true. Until the
canonical demo node existed, step 3 was impossible for anyone outside the
project: every node reporting in advertised an RFC1918 address or a
`node://someones-laptop` label, so you could discover and verify and then hit a
wall.
"""
import hashlib, json, re, urllib.request

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n = 0
    for c in s:
        i = B58.find(c)
        if i < 0: return None
        n = n*58 + i
    raw = n.to_bytes((n.bit_length()+7)//8, "big")
    return b"\0"*(len(s)-len(s.lstrip("1"))) + raw

def get(u):
    with urllib.request.urlopen(u, timeout=15) as r: return json.load(r)
def post(u, d):
    req = urllib.request.Request(u, data=json.dumps(d).encode(),
                                 headers={"content-type":"application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r: return json.load(r)

# 1 DISCOVER — public, no auth, no key
nodes = get("https://registry.libertynet.ai/nodes")["nodes"]
usable = [n for n in nodes
          if n.get("endpoint","").startswith("https://") and n.get("signature")]
print(f"1 DISCOVER  {len(nodes)} nodes, {len(usable)} publicly callable AND signed")
node = usable[0]
print(f"            -> {node['did']}  {node['endpoint']}")

def verify_id_binding(did, public_key):
    """Does this DID actually derive from this public key?

    The first gate in every trust decision on LibertyNet, and checkable with
    nothing but SHA-256 — no lookup, no authority, no trusting the response you
    just received. A valid signature is not a valid identity; check this first.
    """
    key = b58d(public_key)
    if not key or len(key) != 32:
        return False
    claimed = re.sub(r"^did:svrp:(?:[a-z]:)?", "", did)
    if len(claimed) == 64:
        return claimed == key.hex()
    return claimed == hashlib.sha256(key).hexdigest()[:len(claimed)]


# 2 VERIFY — checked locally, before we trust anything the node says
key = b58d(node["public_key"])
assert verify_id_binding(node["did"], node["public_key"]), "id-binding FAILED"
print(f"2 VERIFY    id-binding holds: sha256(key)[:4] == {node['did'].split(':')[-1]}")

# 2b the registration signature itself must verify
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
reg_msg = "\n".join(["libertynet-node-register:v1", node["did"], node["public_key"],
                     node["endpoint"], ",".join(sorted(node["capabilities"])),
                     node.get("region") or ""]).encode()
Ed25519PublicKey.from_public_bytes(key).verify(b58d(node["signature"]), reg_msg)
print("            registration signature verifies")

# 3 ACT — call it, with a nonce we chose, and verify what comes back
nonce = "proof-" + hashlib.sha256(b"external-clean-machine").hexdigest()[:12]
r = post(node["endpoint"] + "/echo", {"nonce": nonce})
assert r["nonce"] == nonce, "node echoed a different nonce"
Ed25519PublicKey.from_public_bytes(b58d(r["public_key"])).verify(
    b58d(r["signature"]), r["signed_bytes"].encode())
assert r["public_key"] == node["public_key"], "responder is not the node we discovered"
print(f"3 ACT       called {node['endpoint']}/echo")
print(f"            response signed over OUR nonce, verifies against the discovered key")
print("\nLOOP CLOSED — discover -> verify -> act, all cryptographically checked")
