/**
 * Ouroboros — Sync protocol (browser)
 *
 * Connects to the relay, performs initial catch-up from ALL peers,
 * deduplicates by op.id, verifies Ed25519 signatures, and forwards
 * incoming operations to local storage in real time.
 *
 * After initial sync completes, a WebRTCPeer is created (if signalingUrl
 * is provided). Live ops are then broadcast over both the relay AND any
 * open WebRTC data channels. If the relay goes down, WebRTC keeps working.
 *
 * Usage:
 *   const ws = sync(db, identity, "ws://localhost:9090", {
 *       signalingUrl: "ws://localhost:8081",
 *       roomId:       "my-room",
 *       onConnect, onSynced, onOperation, onDisconnect,
 *       verify: true,
 *   });
 */

import { getAllOps, mergeOps, getLatestOp } from "../storage/indexedDB.js";
import { verifyMessage }                    from "../identity/identity.js";
import { WebRTCPeer }                       from "../webrtc/webrtc.js";

/**
 * @typedef {Object} SyncOptions
 * @property {(op: object) => void}    [onOperation]    New live op arrived and stored
 * @property {(count: number) => void} [onSynced]       Initial sync finished
 * @property {() => void}              [onConnect]      WebSocket opened
 * @property {() => void}              [onDisconnect]   WebSocket closed
 * @property {(peerId: string) => void}[onPeerJoined]   WebRTC peer connected
 * @property {(peerId: string) => void}[onPeerLeft]     WebRTC peer disconnected
 * @property {boolean}                 [verify=true]    Reject ops with invalid signatures
 * @property {string}                  [signalingUrl]   WebRTC signaling server URL
 * @property {string}                  [roomId]         WebRTC room to join
 */

const DEFAULT_RELAY = "ws://localhost:9090";

/**
 * Connect to the relay and start syncing.
 * Returns an object with the WebSocket and (after sync) the WebRTCPeer.
 *
 * @param {IDBDatabase}  db
 * @param {{ publicKey: string, keyPair: CryptoKeyPair }} identity
 * @param {string}       [url]
 * @param {SyncOptions}  [options]
 * @returns {{ ws: WebSocket, getRTC: () => WebRTCPeer|null }}
 */
export function sync(db, identity, url = DEFAULT_RELAY, options = {}) {
    const {
        onOperation, onSynced, onConnect, onDisconnect,
        onPeerJoined, onPeerLeft,
        verify = true,
        signalingUrl = null,
        roomId = "ouroboros-default",
    } = options;

    /** @type {WebRTCPeer|null} */
    let rtcPeer = null;

    const ws = new WebSocket(url);

    // ---------------------------------------------------------------- //
    // WebSocket — relay connection
    // ---------------------------------------------------------------- //

    ws.addEventListener("open", async () => {
        console.log(`[sync] connected → ${url}`);
        onConnect?.();

        const latest = await getLatestOp(db).catch(() => null);
        const since  = latest ? latest.ts : 0;
        ws.send(JSON.stringify({ type: "SYNC_REQ", payload: { since } }));
    });

    ws.addEventListener("message", async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); }
        catch { return; }

        switch (msg.type) {

            // Relay asking us to share history with a joining node
            case "SYNC_PEER": {
                const ops = await getAllOps(db, msg.since ?? 0).catch(() => []);
                ws.send(JSON.stringify({
                    type:    "SYNC_REQ_FILLED",
                    for:     msg.for,
                    payload: { operations: ops },
                }));
                break;
            }

            // One peer's batch of history
            case "SYNC_REQ_FILLED": {
                const ops     = msg.payload?.operations ?? [];
                const trusted = verify ? await filterVerified(ops) : ops;
                const written = await mergeOps(db, trusted).catch(() => 0);
                console.log(`[sync] batch: ${ops.length} ops, ${written} new`);
                break;
            }

            // Initial sync complete — now start WebRTC
            case "SYNC_COMPLETE": {
                console.log("[sync] initial sync complete");
                onSynced?.();

                if (signalingUrl && !rtcPeer) {
                    rtcPeer = _startWebRTC({
                        db, identity, verify,
                        signalingUrl, roomId,
                        onOperation, onPeerJoined, onPeerLeft,
                    });
                }
                break;
            }

            // Live op from relay
            case "SHARED_OPERATION": {
                const op = msg.payload;
                if (!op?.id) break;

                if (verify && !(await isVerified(op))) {
                    console.warn(`[sync] dropped op ${op.id?.slice(0, 8)} — bad signature`);
                    break;
                }

                await mergeOps(db, [op]).catch(() => {});
                onOperation?.(op);
                break;
            }

            default:
                console.warn(`[sync] unknown message type: ${msg.type}`);
        }
    });

    ws.addEventListener("close", () => {
        console.log("[sync] disconnected from relay");
        onDisconnect?.();
    });

    ws.addEventListener("error", (e) => console.error("[sync] error", e));

    return {
        ws,
        /** @returns {WebRTCPeer|null} */
        getRTC: () => rtcPeer,
    };
}

/**
 * Sign and broadcast a new operation.
 * Sends over the relay AND all open WebRTC data channels.
 *
 * @param {WebSocket}       ws
 * @param {IDBDatabase}     db
 * @param {{ publicKey: string, keyPair: CryptoKeyPair }} identity
 * @param {object}          op
 * @param {WebRTCPeer|null} [rtcPeer]
 * @returns {Promise<object>} The stored, signed operation
 */
export async function shareOperation(ws, db, identity, op, rtcPeer = null) {
    const { signMessage } = await import("../identity/identity.js");

    const full = {
        id:        crypto.randomUUID(),
        ts:        Date.now(),
        publicKey: identity.publicKey,
        ...op,
    };

    const { sig: _omit, ...body } = full;
    const sig = await signMessage(identity.keyPair.privateKey, JSON.stringify(body));
    const signed = { ...full, sig };

    await mergeOps(db, [signed]);

    // Broadcast over relay
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "SHARE_OPERATION", payload: signed }));
    }

    // Broadcast over WebRTC (direct, no relay hop)
    if (rtcPeer) {
        rtcPeer.broadcast({ type: "SHARE_OPERATION", payload: signed });
        console.log("[sync] op broadcast over WebRTC");
    }

    return signed;
}

// ------------------------------------------------------------------ //
// WebRTC setup
// ------------------------------------------------------------------ //

/**
 * Create and configure a WebRTCPeer that handles incoming ops
 * the same way the relay does.
 */
function _startWebRTC({ db, identity, verify, signalingUrl, roomId, onOperation, onPeerJoined, onPeerLeft }) {
    console.log(`[sync] starting WebRTC → ${signalingUrl} room=${roomId}`);

    const rtc = new WebRTCPeer(roomId, signalingUrl, {
        onPeerJoined: (peerId) => {
            console.log(`[webrtc] peer joined: ${peerId.slice(0, 8)}`);
            onPeerJoined?.(peerId);
        },

        onPeerLeft: (peerId) => {
            console.log(`[webrtc] peer left: ${peerId.slice(0, 8)}`);
            onPeerLeft?.(peerId);
        },

        onMessage: async (data, peerId) => {
            if (data?.type !== "SHARE_OPERATION" || !data?.payload?.id) return;

            const op = data.payload;

            if (verify && !(await isVerified(op))) {
                console.warn(`[webrtc] dropped op ${op.id?.slice(0, 8)} — bad signature`);
                return;
            }

            await mergeOps(db, [op]).catch(() => {});
            console.log(`[webrtc] op received from ${peerId.slice(0, 8)}: ${op.id.slice(0, 8)}`);
            onOperation?.(op);
        },
    });

    return rtc;
}

// ------------------------------------------------------------------ //
// Signature helpers
// ------------------------------------------------------------------ //

async function isVerified(op) {
    if (!op.sig || !op.publicKey) return false;
    try {
        const { sig, ...body } = op;
        return await verifyMessage(op.publicKey, sig, JSON.stringify(body));
    } catch {
        return false;
    }
}

async function filterVerified(ops) {
    const results = await Promise.all(ops.map(async (op) => ({
        op,
        ok: await isVerified(op),
    })));
    const dropped = results.filter(r => !r.ok).length;
    if (dropped > 0) console.warn(`[sync] dropped ${dropped} op(s) with invalid signatures`);
    return results.filter(r => r.ok).map(r => r.op);
}
