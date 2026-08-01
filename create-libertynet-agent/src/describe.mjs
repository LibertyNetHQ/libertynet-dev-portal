/**
 * Plain English → a scaffold plan.
 *
 *     npx create-libertynet-agent --describe "watch asian inference nodes and
 *                                             tell me when one drops off"
 *
 * There is no model behind this, and that is deliberate. The scaffolder has zero
 * dependencies and must work offline, on a plane, in five years; shipping a
 * dependency on a hosted LLM to pick between four agent types would be a poor
 * trade. What this does instead is a grounded, deterministic read of the
 * sentence against a fixed vocabulary.
 *
 * The part that matters is not the type selection — it is the refusal.
 *
 * Ask any assistant for "an agent that pays nodes from my balance" and it will
 * cheerfully write one, because that sentence sounds like it should work. Every
 * capability word here is checked against `api-spec/status.json`, the same
 * matrix that drives every badge on the site. A description that asks for
 * something `not_yet_wired` scaffolds the parts that exist and says plainly
 * which parts do not. A description that asks for something LibertyNet has
 * deliberately never built — wallets, transfers, swaps, staking, trading —
 * is refused outright rather than stubbed, because a stub is an implied promise.
 *
 * A wrong guess about agent type costs the reader ten seconds. A scaffold that
 * quietly implies a payment system exists costs them a great deal more.
 */

import { AGENT_TYPES, CAPABILITIES } from "./templates.mjs";

/**
 * Things LibertyNet does not have and is not going to have inside this scope.
 * Named in the project contract, not inferred — see CLAUDE.md "Forbidden".
 */
const REFUSED = [
  {
    match: /\b(wallet|wallets)\b/i,
    subject: "wallets",
  },
  {
    match: /\b(transfer|transfers|transferring|send (?:money|funds|tokens)|payout|withdraw)\b/i,
    subject: "value transfer",
  },
  {
    match: /\b(swap|swapping|dex|exchange rate|trade|trading|buy|sell)\b/i,
    subject: "swapping or trading",
  },
  {
    match: /\b(stake|staking|staked|yield farm)\b/i,
    subject: "staking",
  },
  {
    match: /\b(pay|paying|pays|payment|payments|charge|invoice|billing)\b/i,
    subject: "payments",
  },
];

/**
 * Words that point at a capability area, and the status.json group they belong
 * to. The status lookup is done at plan time so the warning quotes the real
 * current status rather than one hard-coded here.
 */
const AREA_WORDS = [
  { area: "economics", words: /\b(credit|credits|balance|balances|earning|earnings|reward|rewards)\b/i },
  { area: "oracle", words: /\b(oracle|price|prices|feed|feeds)\b/i },
  { area: "binding", words: /\b(bind|binding|operator|claim|ownership)\b/i },
  { area: "discovery", words: /\b(node|nodes|network|discover|discovery|peer|peers|registry)\b/i },
  { area: "identity", words: /\b(identity|identities|did|dids|key|keys|verify|verification|signature)\b/i },
];

/** Signals for each agent type, strongest first. */
const TYPE_SIGNALS = [
  {
    type: "monitor",
    match: /\b(watch|watches|watching|monitor|monitoring|track|tracking|alert|alerts|notify|observe|dashboard|report|reports|poll|polling|when .* (?:goes|drops|comes))\b/i,
  },
  {
    type: "service",
    match: /\b(serve|serves|serving|offer|offers|offering|provide|provides|expose|exposes|handle requests|accept requests|respond to|api|endpoint|server)\b/i,
  },
  {
    type: "solver",
    match: /\b(solve|solves|solving|solver|intent|intents|bid|bids|bidding|fulfil|fulfill|route|routing)\b/i,
  },
];

const CAP_WORDS = {
  inference: /\b(inference|infer|model|models|llm|gpu|prompt|prompts|generate text)\b/i,
  storage: /\b(storage|store|stores|storing|file|files|blob|blobs|disk)\b/i,
  verification: /\b(verify|verifies|verification|check|checks|validate|validates|attest)\b/i,
  proof: /\b(proof|proofs|prove|evidence|receipt|receipts)\b/i,
  solver: /\b(solve|solver|solving|intent|intents)\b/i,
  oracle: /\b(oracle|price feed|external data|report data)\b/i,
};

const STOP = new Set(
  ("a an and are as at be but by can do does for from get gives has have i in is it its me my of on " +
    "or so that the their them then there these they this to us use want with you your an agent " +
    "that which when where who will would should could every all any some new").split(" "),
);

/**
 * Turn a description into a project name.
 *
 * Prefers the concrete nouns, because "asia-inference-monitor" is a better
 * directory name than "an-agent-that-watches".
 */
export function nameFromDescription(description) {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && w.length > 2);

  const picked = [];
  for (const w of words) {
    if (picked.includes(w)) continue;
    picked.push(w);
    if (picked.length === 3) break;
  }

  const slug = picked.join("-").replace(/^-+|-+$/g, "");
  // Names must start with a letter and stay short; fall back rather than emit
  // something the validator will reject.
  return /^[a-z]/.test(slug) && slug.length >= 3 ? slug.slice(0, 40) : "libertynet-agent";
}

/**
 * Read a description against the capability matrix.
 *
 * @param {string} description  what the developer typed
 * @param {object} status       parsed api-spec/status.json
 * @returns {{name, type, capabilities, refusals, warnings, reasoning}}
 */
export function interpret(description, status) {
  if (!description || !description.trim()) {
    throw new TypeError("--describe needs a sentence");
  }

  const text = description.trim();
  const reasoning = [];

  // -- refusals first -------------------------------------------------------
  //
  // Before deciding what to build, decide what not to. If the sentence asks for
  // something that does not exist and will not, saying so is the whole job.

  const refusals = [];
  for (const rule of REFUSED) {
    if (rule.match.test(text) && !refusals.some((r) => r.subject === rule.subject)) {
      refusals.push({
        subject: rule.subject,
        reason:
          `LibertyNet has no ${rule.subject}. No endpoint in this protocol moves value — ` +
          "not a wallet, not a transfer, not a swap, not staking, not trading. " +
          "Scaffolding a stub for it would imply one is coming.",
      });
    }
  }

  // -- agent type -----------------------------------------------------------

  let type = null;
  for (const signal of TYPE_SIGNALS) {
    if (signal.match.test(text)) {
      type = signal.type;
      reasoning.push(`type "${type}" — the description asks to ${signal.type === "monitor" ? "observe" : signal.type === "service" ? "offer something" : "solve intents"}`);
      break;
    }
  }
  if (!type) {
    type = "custom";
    reasoning.push('type "custom" — nothing in the description pointed at monitoring, serving or solving');
  }

  // -- capabilities ---------------------------------------------------------

  const capabilities = [];
  for (const cap of CAPABILITIES) {
    const rx = CAP_WORDS[cap.id];
    if (rx && rx.test(text)) capabilities.push(cap.id);
  }

  // A service that offers nothing is not a service. Declaring inference is the
  // honest default only because it is the one capability actually observed on
  // the live network today.
  if (type === "service" && capabilities.length === 0) {
    capabilities.push("inference");
    reasoning.push('capability "inference" — a service must offer something, and inference is the only capability present on the live network');
  } else if (capabilities.length) {
    reasoning.push(`capabilities ${capabilities.join(", ")} — named in the description`);
  }

  // -- ground every area against the real matrix ----------------------------

  const warnings = [];
  const byId = new Map(status.groups.map((g) => [g.id, g]));

  for (const { area, words } of AREA_WORDS) {
    if (!words.test(text)) continue;

    const group = byId.get(area);
    if (!group) continue;

    const statuses = group.endpoints.map((e) => e.status);
    const anyLive = statuses.includes("implemented");
    const allUnbuilt = statuses.every((s) => s === "planned");

    if (allUnbuilt) {
      warnings.push({
        area,
        status: "planned",
        message:
          `The description mentions ${group.title.toLowerCase()}, which is planned — ` +
          "designed, not built. There is nothing behind it, so the scaffold does not call it.",
      });
      reasoning.push(`skipped ${area} — every endpoint in that group is planned`);
    } else if (!anyLive) {
      warnings.push({
        area,
        status: statuses.includes("not_yet_wired") ? "not_yet_wired" : "testing",
        message:
          `The description mentions ${group.title.toLowerCase()}. Those endpoints answer, ` +
          "but their data source is not connected: they return zeros with " +
          '"source": "not_yet_wired". Never show one of those zeros as a measurement.',
      });
      reasoning.push(`flagged ${area} — answers, but the numbers are placeholders`);
    }
  }

  return {
    description: text,
    name: nameFromDescription(text),
    type,
    capabilities,
    refusals,
    warnings,
    reasoning,
  };
}
