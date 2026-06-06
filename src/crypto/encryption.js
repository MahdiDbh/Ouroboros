/**
 * Ouroboros — Payload Encryption (browser, Web Crypto API)
 *
 * Two-layer design:
 *   1. ECDH  — each node derives a shared secret from its own private key
 *              and the recipient's public key. No secret is ever transmitted.
 *   2. AES-GCM — the shared secret is used to encrypt / decrypt op.data.
 *              A random 12-byte IV is generated per encrypt call and
 *              prepended to the ciphertext so the receiver can decrypt.
 *
 * Usage:
 *   import { createEncryptionIdentity, deriveSharedKey,
 *            encryptData, decryptData } from "ouroboros/crypto";
 */

const toHex  = (buf) =>
    [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex) =>
    Uint8Array.from(hex.match(/.{2}/g).map(b => parseInt(b, 16)));

// ------------------------------------------------------------------ //
// ECDH identity
// ------------------------------------------------------------------ //

/**
 * Generate an ECDH keypair for encryption.
 * Separate from the Ed25519 signing identity.
 *
 * @returns {Promise<{ publicKey: string, keyPair: CryptoKeyPair }>}
 */
export async function createEncryptionIdentity() {
    const keyPair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );

    const publicKeyBuf = await crypto.subtle.exportKey("raw", keyPair.publicKey);

    return {
        publicKey: toHex(publicKeyBuf),
        keyPair,
    };
}

// ------------------------------------------------------------------ //
// Shared key derivation
// ------------------------------------------------------------------ //

/**
 * Derive a shared AES-GCM key from our ECDH private key and a peer's public key.
 * Both sides derive the same key — no key exchange message needed.
 *
 * @param {CryptoKey}  ourPrivateKey     ECDH private key (from createEncryptionIdentity)
 * @param {string}     theirPublicKeyHex Hex-encoded ECDH public key of the peer
 * @returns {Promise<CryptoKey>} AES-GCM key ready for encrypt/decrypt
 */
export async function deriveSharedKey(ourPrivateKey, theirPublicKeyHex) {
    const theirPublicKey = await crypto.subtle.importKey(
        "raw", fromHex(theirPublicKeyHex),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
    );

    return crypto.subtle.deriveKey(
        { name: "ECDH", public: theirPublicKey },
        ourPrivateKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

// ------------------------------------------------------------------ //
// Encrypt / Decrypt
// ------------------------------------------------------------------ //

/**
 * Encrypt an object with AES-GCM.
 * Returns a hex string: 24-char IV + ciphertext.
 *
 * @param {CryptoKey} sharedKey  AES-GCM key from deriveSharedKey()
 * @param {object}    data       Plain object to encrypt
 * @returns {Promise<string>}    Hex-encoded IV+ciphertext
 */
export async function encryptData(sharedKey, data) {
    const iv        = crypto.getRandomValues(new Uint8Array(12));
    const encoded   = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        sharedKey,
        encoded
    );

    // Prepend IV so receiver can extract it
    const result = new Uint8Array(iv.byteLength + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.byteLength);
    return toHex(result);
}

/**
 * Decrypt a hex-encoded IV+ciphertext produced by encryptData().
 *
 * @param {CryptoKey} sharedKey  AES-GCM key from deriveSharedKey()
 * @param {string}    hex        Hex-encoded IV+ciphertext
 * @returns {Promise<object>}    Original plain object
 */
export async function decryptData(sharedKey, hex) {
    const bytes     = fromHex(hex);
    const iv        = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12);

    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        sharedKey,
        ciphertext
    );

    return JSON.parse(new TextDecoder().decode(decrypted));
}
