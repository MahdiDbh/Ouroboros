/**
 * ZoethraDB — Node identity (browser, Web Crypto API)
 *
 * Each peer generates an Ed25519 key pair on startup.
 * The keypair is persisted in localStorage so the same identity
 * survives page refreshes and browser restarts.
 *
 * @typedef {Object} Identity
 * @property {string}    publicKey   Hex-encoded Ed25519 public key
 * @property {string}    privateKey  Hex-encoded PKCS#8 private key
 * @property {CryptoKeyPair} keyPair Raw CryptoKeyPair (for sign/verify)
 */

const STORAGE_KEY = "ouroboros:identity";

const toHex = (buf) =>
    [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex) =>
    Uint8Array.from(hex.match(/.{2}/g).map(b => parseInt(b, 16)));

/**
 * Load a saved identity from localStorage, or generate and save a new one.
 * @returns {Promise<Identity>}
 */
export async function createIdentity() {
    const saved = await _load();
    if (saved) return saved;

    let keyPair;
    try {
        keyPair = await crypto.subtle.generateKey(
            { name: "Ed25519" },
            true,
            ["sign", "verify"]
        );
    } catch (err) {
        throw new Error(
            "Ed25519 not supported in this browser. " +
            "Use Chrome 113+, Firefox 130+, or Safari 17+. Original error: " + err.message
        );
    }

    const [publicKeyBuf, privateKeyBuf] = await Promise.all([
        crypto.subtle.exportKey("raw",   keyPair.publicKey),
        crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    ]);

    const identity = {
        publicKey:  toHex(publicKeyBuf),
        privateKey: toHex(privateKeyBuf),
        keyPair,
    };

    _save(identity);
    return identity;
}

/**
 * Erase the saved identity from localStorage.
 * Next call to createIdentity() will generate a fresh keypair.
 */
export function clearIdentity() {
    localStorage.removeItem(STORAGE_KEY);
}

// ------------------------------------------------------------------ //
// localStorage persistence
// ------------------------------------------------------------------ //

function _save(identity) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            publicKey:  identity.publicKey,
            privateKey: identity.privateKey,
        }));
    } catch {
        // localStorage unavailable (e.g. private mode with storage blocked) — silently skip
    }
}

async function _load() {
    let stored;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        stored = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!stored?.publicKey || !stored?.privateKey) return null;

    try {
        const [publicKey, privateKey] = await Promise.all([
            crypto.subtle.importKey(
                "raw", fromHex(stored.publicKey),
                { name: "Ed25519" }, true, ["verify"]
            ),
            crypto.subtle.importKey(
                "pkcs8", fromHex(stored.privateKey),
                { name: "Ed25519" }, true, ["sign"]
            ),
        ]);

        return {
            publicKey:  stored.publicKey,
            privateKey: stored.privateKey,
            keyPair:    { publicKey, privateKey },
        };
    } catch {
        // Corrupted entry — remove it so we regenerate cleanly
        localStorage.removeItem(STORAGE_KEY);
        return null;
    }
}

/**
 * Sign a message string with the node's private key.
 * @param {CryptoKey} privateKey
 * @param {string}    message
 * @returns {Promise<string>} Hex-encoded signature
 */
export async function signMessage(privateKey, message) {
    const encoded = new TextEncoder().encode(message);
    const sigBuf  = await crypto.subtle.sign("Ed25519", privateKey, encoded);
    return toHex(sigBuf);
}

/**
 * Verify a signature against a public key.
 * @param {string} publicKeyHex  Hex-encoded public key
 * @param {string} signature     Hex-encoded signature
 * @param {string} message       Original message string
 * @returns {Promise<boolean>}
 */
export async function verifyMessage(publicKeyHex, signature, message) {
    const keyBuf  = Uint8Array.from(publicKeyHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const sigBuf  = Uint8Array.from(signature.match(/.{2}/g).map(b => parseInt(b, 16)));
    const encoded = new TextEncoder().encode(message);

    const publicKey = await crypto.subtle.importKey(
        "raw", keyBuf,
        { name: "Ed25519" },
        false,
        ["verify"]
    );

    return crypto.subtle.verify("Ed25519", publicKey, sigBuf, encoded);
}
