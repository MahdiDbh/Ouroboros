# Ouroboros

> **Semi-decentralized, cryptographically signed, browser-native peer-to-peer database.**

Each node is a full replica. Data lives in the browser. The network heals itself.

```
Browser A             Relay (Node.js)       Browser B             Browser C
┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│  IndexedDB  │◀─WS─▶ │   router    │◀─WS─▶ │  IndexedDB  │       │  IndexedDB  │
│  full copy  │       │  stateless  │       │  full copy  │ ◀─RTC─▶│  full copy  │
└─────────────┘       └─────────────┘       └─────────────┘       └─────────────┘
      ▲                                             ▲                     ▲
      └────────────── every write replicates ───────┴─────────────────────┘
```

After initial sync, peers communicate directly over **WebRTC DataChannels** — the relay is only needed for discovery and the first handshake.

---

## Design

Ouroboros is built on browser-native primitives — no external dependencies for the data layer:

**IndexedDB** — each node holds the complete operation log. Reads are local. Data survives page refreshes and browser restarts.

**WebSocket relay** — a stateless router. It holds no data. Its only job is to forward messages between peers and coordinate the initial sync handshake. It can go down without data loss; peers reconnect and catch up automatically.

**WebRTC DataChannels** — after initial sync, peers establish direct connections via RTCDataChannel. Live operations are broadcast over WebRTC directly — no relay hop. If the relay goes down, the data path keeps working.

**Web Crypto (Ed25519)** — every node generates a persistent keypair (saved to localStorage). Every write is signed with the node's private key. Every incoming operation is verified before it touches storage. Invalid or unsigned operations are silently dropped.

**AES-GCM Encryption** — operation payloads can be encrypted end-to-end using ECDH-derived shared keys. The relay and signaling server only see ciphertext.

**LWW-CRDT** — concurrent writes to the same key are resolved deterministically: highest timestamp wins; ties broken by public key (lexicographic). Every peer reaches the same state given the same set of operations, regardless of arrival order.

---

## Sync protocol

```
Joiner                    Relay                     Peer A        Peer B
  │                         │                          │              │
  │──── SYNC_REQ(since) ───▶│                          │              │
  │                         │──── SYNC_PEER(since) ───▶│              │
  │                         │──── SYNC_PEER(since) ────────────────▶  │
  │                         │                          │              │
  │◀─── SYNC_REQ_FILLED ────│◀─── ops[] ──────────────│              │
  │   merge by op.id        │                          │              │
  │◀─── SYNC_REQ_FILLED ────│◀─── ops[] ────────────────────────────  │
  │   merge by op.id        │                          │              │
  │◀─── SYNC_COMPLETE ──────│  (all peers responded)   │              │
  │                         │                          │              │
  │  [WebRTC channels open] │                          │              │
  │◀────────────────── RTCDataChannel ────────────────▶│              │
```

The relay asks **every** connected peer simultaneously. The joiner merges all incoming batches, deduplicating by `op.id`. After `SYNC_COMPLETE`, WebRTC channels are established for direct peer-to-peer communication.

---

## Storage schema

```
ObjectStore: "Operations"
  keyPath : id       UUID v4 — globally unique across all nodes
  index   : by_ts    ts (non-unique) — range scans for sync catchup
```

```js
{
    id:        "e3d4f1a2-...",     // keyPath — UUID v4
    ts:        1718000000000,      // Unix ms, indexed
    publicKey: "a3f8c2...",        // Ed25519 public key (hex)
    sig:       "9b2e47...",        // Ed25519 signature (hex) over body without sig
    data:      { key: "price", value: "42.5", ... },
    signals:   { ... },
}
```

---

## Requirements

- Node.js ≥ 18
- npm
- Browser: Chrome 113+, Firefox 130+, Safari 17+ (Ed25519 Web Crypto required)

## Install

```bash
git clone https://github.com/MahdiDbh/Ouroboros
cd Ouroboros
npm install
```

## Run

```bash
PORT=9090 npm run relay       # WebSocket relay      → ws://localhost:9090
npm run relay:signaling        # WebRTC signaling     → ws://localhost:8081
npx serve .                    # HTTP server          → http://localhost:3000
```

Open `http://localhost:3000/examples/index.html` in two browser tabs to test P2P sync.

---

## Usage

### Relay (Node.js)

```js
import { createRelayServer } from "ouroboros/relay";

const { wss, close } = createRelayServer(9090);
// close() shuts down gracefully
```

### Browser node

```js
import { openDB }               from "ouroboros/storage";
import { sync, shareOperation } from "ouroboros/sync";
import { createIdentity }       from "ouroboros/identity";

// Ed25519 keypair — persisted to localStorage, reloaded on next session
const identity = await createIdentity();
const db       = await openDB();

const { ws, getRTC } = sync(db, identity, "ws://localhost:9090", {
    onConnect:    ()       => console.log("connected to relay"),
    onSynced:     ()       => console.log("caught up with the network"),
    onOperation:  (op)     => console.log("live op received:", op.id),
    onDisconnect: ()       => console.log("relay unreachable — local reads still work"),
    onPeerJoined: (peerId) => console.log("WebRTC peer joined:", peerId),
    onPeerLeft:   (peerId) => console.log("WebRTC peer left:", peerId),
    verify:       true,
    signalingUrl: "ws://localhost:8081",
    roomId:       "my-room",
});

ws.addEventListener("open", async () => {
    const op = await shareOperation(ws, db, identity, {
        data:    { key: "price", value: "42.5" },
        signals: { entry: "RSI < 30", exit: "RSI > 70" },
    }, getRTC());
    // op = { id, ts, publicKey, sig, data, signals }
});
```

### Query API

```js
import { getAllOps, queryOps, countOps, getOpById } from "ouroboros/storage";

// All ops since timestamp
const ops = await getAllOps(db, since);

// Filter by any field (dot-notation)
const bySource = await queryOps(db, { "data.source": "node-a" });
const byKey    = await queryOps(db, { "data.key": "price" });

// With options
const recent = await queryOps(db, { "data.key": "price" }, {
    since: Date.now() - 60_000,
    limit: 10,
});

// Count and lookup
const total = await countOps(db);
const op    = await getOpById(db, "e3d4f1a2-...");
```

### CRDT — current state

```js
import { getAllOps }             from "ouroboros/storage";
import { buildState, stateToObject } from "ouroboros/crdt";

const ops   = await getAllOps(db, 0);
const state = buildState(ops);

// state is a Map<key, { value, ts, publicKey, opId }>
console.log(state.get("price").value);  // → "42.5"

// plain object view
const snapshot = stateToObject(state);
// → { price: "42.5", volume: "1000", ... }
```

### Payload encryption

```js
import { createEncryptionIdentity, deriveSharedKey,
         encryptData, decryptData } from "ouroboros/crypto";

const myKeys    = await createEncryptionIdentity();
const sharedKey = await deriveSharedKey(myKeys.keyPair.privateKey, peerPublicKeyHex);

const ciphertext = await encryptData(sharedKey, { price: "42.5" });
const plain      = await decryptData(sharedKey, ciphertext);
```

---

## Message protocol

| Message | Direction | Description |
|---|---|---|
| `SYNC_REQ` | client → relay | Connect handshake. Carries `since` (latest local `ts`). |
| `SYNC_PEER` | relay → **all** peers | Request history since `since` for a joiner. Sent in parallel. |
| `SYNC_REQ_FILLED` | peer → relay → joiner | One peer's history batch. Joiner merges by `op.id`. |
| `SYNC_COMPLETE` | relay → joiner | All peers have responded. Initial sync is finished. |
| `SHARE_OPERATION` | client → relay / WebRTC | Broadcast a signed op. |
| `SHARED_OPERATION` | relay → clients | Delivery of a peer's signed op. Verified before storage. |

---

## Module map

```
src/
├── index.js               public re-exports
├── relay/
│   ├── server.js          stateless WS relay — broadcast + multi-peer sync
│   └── signaling.js       WebRTC signaling — rooms, offer/answer/ICE forwarding
├── sync/
│   └── sync.js            sync protocol — parallel catch-up, dedup, WebRTC wiring
├── storage/
│   └── indexedDB.js       IndexedDB — UUID keyPath, ts index, query API
├── identity/
│   └── identity.js        Ed25519 — keygen, sign, verify, localStorage persistence
├── messages/
│   └── messages.js        message type constants + signed envelope factory
├── webrtc/
│   └── webrtc.js          WebRTC peer — RTCDataChannel management
└── crdt/
    └── lww.js             LWW-CRDT — deterministic conflict resolution
examples/
├── index.html             browser test page
├── browser-node.js        browser usage example
└── start-relay.js         relay server example
```

---

## Exports

```js
import { createRelayServer }                              from "ouroboros/relay";
import { sync, shareOperation }                           from "ouroboros/sync";
import { createIdentity, clearIdentity,
         signMessage, verifyMessage }                     from "ouroboros/identity";
import { openDB, setData, getData, getLatestOp,
         getAllOps, mergeOps, hasOp,
         getOpById, countOps, queryOps }                  from "ouroboros/storage";
import { makeMessage, MessageType }                       from "ouroboros/messages";
import { createEncryptionIdentity, deriveSharedKey,
         encryptData, decryptData }                       from "ouroboros/crypto";
import { buildState, applyOp, resolveConflict,
         stateToObject }                                  from "ouroboros/crdt";
```

---

## Why "semi-decentralized"

The data layer is fully decentralized — every peer holds a complete, independently readable replica. The relay is a stateless message router, not a database. It stores nothing. Losing it loses no data.

After the initial handshake, peers sync directly over WebRTC DataChannels — the relay is not in the live data path. The remaining centralization is **peer discovery**: new nodes still need a known relay address to find the network. DHT or hardcoded bootstrap nodes would be the final step toward full decentralization.

---

## License

MIT
