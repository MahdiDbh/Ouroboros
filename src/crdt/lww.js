/**
 * Ouroboros — LWW (Last-Write-Wins) CRDT
 *
 * Merges a stream of operations into a single key→value state.
 * Conflict rule: highest ts wins. Equal ts → highest publicKey (lexicographic).
 * This is deterministic — every peer reaches the same state given the same ops,
 * regardless of the order they arrived.
 *
 * Operations must have:
 *   { id, ts, publicKey, data: { key: string, value: any }, ... }
 *
 * Usage:
 *   import { buildState, applyOp, resolveConflict } from "ouroboros/crdt";
 *
 *   const ops   = await getAllOps(db);
 *   const state = buildState(ops);
 *   // state.get("price") → { value: "200", ts: 1000005, publicKey: "bbb...", opId: "..." }
 */

/**
 * @typedef {Object} LWWEntry
 * @property {unknown} value
 * @property {number}  ts
 * @property {string}  publicKey
 * @property {string}  opId
 */

// ------------------------------------------------------------------ //
// Core
// ------------------------------------------------------------------ //

/**
 * Decide which of two entries wins.
 * Higher ts wins. Tie → higher publicKey (lexicographic) wins.
 *
 * @param {LWWEntry} a
 * @param {LWWEntry} b
 * @returns {LWWEntry} the winner
 */
export function resolveConflict(a, b) {
    if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
    return a.publicKey >= b.publicKey ? a : b;
}

/**
 * Apply a single operation to an existing LWW state map.
 * Mutates the map in place — use on a copy if immutability matters.
 *
 * @param {Map<string, LWWEntry>} state
 * @param {object} op   Must have { id, ts, publicKey, data: { key, value } }
 * @returns {Map<string, LWWEntry>} the same map (mutated)
 */
export function applyOp(state, op) {
    const key = op.data?.key;
    if (key === undefined || key === null) return state;

    const incoming = {
        value:     op.data.value,
        ts:        op.ts,
        publicKey: op.publicKey,
        opId:      op.id,
    };

    const existing = state.get(key);
    if (!existing || resolveConflict(incoming, existing) === incoming) {
        state.set(key, incoming);
    }

    return state;
}

/**
 * Build the current state from an array of operations.
 * Applies all ops and returns a Map of key → winning LWWEntry.
 *
 * @param {object[]} ops
 * @returns {Map<string, LWWEntry>}
 */
export function buildState(ops) {
    const state = new Map();
    for (const op of ops) applyOp(state, op);
    return state;
}

/**
 * Convert the LWW state map to a plain object for easy display/serialization.
 *
 * @param {Map<string, LWWEntry>} state
 * @returns {Record<string, unknown>}
 */
export function stateToObject(state) {
    const obj = {};
    for (const [key, entry] of state) {
        obj[key] = entry.value;
    }
    return obj;
}
