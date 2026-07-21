/* Eon Consensus - Deterministic hash-based voting among 1000 delegates */
const DELEGATIONS = 1000;
function eon_consensus(text) {
  const msg_hash = require("crypto").createHash("sha256").update(text).digest("hex");
  const seed = parseInt(msg_hash.slice(0, 16), 16);
  const votes = {};
  for (let i = 0; i < DELEGATIONS; i++) {
    const h = require("crypto").createHash("sha256").update(`${seed}:${i}:eon`).digest("hex");
    const choice = String.fromCharCode(97 + (parseInt(h.slice(0, 8), 16) % 26));
    votes[choice] = (votes[choice] || 0) + 1;
  }
  let top = "", topCount = 0;
  for (const [k, v] of Object.entries(votes)) {
    if (v > topCount) { top = k; topCount = v; }
  }
  const sig = require("crypto").createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { delegations: DELEGATIONS, top_choice: top, top_votes: topCount, consensus_hash: sig };
}
module.exports = { eon_consensus };
