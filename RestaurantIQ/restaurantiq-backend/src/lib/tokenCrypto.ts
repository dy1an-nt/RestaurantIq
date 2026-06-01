import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for integration tokens (Square / DoorDash) at rest.
 *
 * Stored format (unchanged, backward compatible): `iv:authTag:ciphertext`, hex.
 *
 * Key rotation
 * ------------
 * Encryption always uses the *active* key. Decryption tries the active key
 * first, then each legacy key in order — so values encrypted under an older key
 * stay readable after a rotation. Configure via:
 *
 *   ACTIVE_TOKEN_ENCRYPTION_KEY    – current key, used for all new ciphertext
 *   LEGACY_TOKEN_ENCRYPTION_KEYS   – comma-separated older keys (decrypt only)
 *
 * For backward compatibility, when ACTIVE_TOKEN_ENCRYPTION_KEY is unset we fall
 * back to the historical TOKEN_ENCRYPTION_KEY. Each key is 64 hex chars (32 bytes).
 *
 * Transparent migration: callers that decrypt a value can inspect
 * `decryptTokenWithMeta().usedActiveKey` — when false, the value was read with a
 * legacy key and should be re-encrypted (via encryptToken, which uses the active
 * key) and persisted, migrating ciphertext forward over time.
 */

const ALGORITHM = 'aes-256-gcm';

function decodeKey(hex: string, label: string): Buffer {
  const key = Buffer.from(hex.trim(), 'hex');
  if (key.length !== 32) {
    throw new Error(`${label} must be 64 hex characters (32 bytes)`);
  }
  return key;
}

/** The key used to encrypt all new values. */
function getActiveKey(): Buffer {
  const hex = process.env.ACTIVE_TOKEN_ENCRYPTION_KEY ?? process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('ACTIVE_TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY) is not set');
  }
  return decodeKey(hex, 'ACTIVE_TOKEN_ENCRYPTION_KEY');
}

/** Ordered legacy keys, tried only when the active key fails to decrypt. */
function getLegacyKeys(): Buffer[] {
  const raw = process.env.LEGACY_TOKEN_ENCRYPTION_KEYS ?? '';
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k, i) => decodeKey(k, `LEGACY_TOKEN_ENCRYPTION_KEYS[${i}]`));
}

export function encryptToken(plaintext: string): string {
  const key = getActiveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Attempt decryption with a single key; null if authentication fails. */
function tryDecrypt(key: Buffer, iv: Buffer, authTag: Buffer, ciphertext: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface DecryptResult {
  plaintext: string;
  /** True when decryption succeeded with the active key; false means a legacy
   * key was used and the caller should re-encrypt to migrate the value. */
  usedActiveKey: boolean;
}

/**
 * Decrypt `iv:authTag:ciphertext`, trying the active key then each legacy key.
 * Throws a controlled error if no configured key can decrypt the value.
 */
export function decryptTokenWithMeta(encrypted: string): DecryptResult {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const active = getActiveKey();
  const fromActive = tryDecrypt(active, iv, authTag, ciphertext);
  if (fromActive !== null) return { plaintext: fromActive, usedActiveKey: true };

  for (const legacy of getLegacyKeys()) {
    const fromLegacy = tryDecrypt(legacy, iv, authTag, ciphertext);
    if (fromLegacy !== null) return { plaintext: fromLegacy, usedActiveKey: false };
  }

  throw new Error('Unable to decrypt token: no configured key matched');
}

export function decryptToken(encrypted: string): string {
  return decryptTokenWithMeta(encrypted).plaintext;
}

/**
 * Lenient decrypt for ingestion paths: returns the value untouched if it isn't
 * in encrypted form, and swallows decrypt failures (returning the raw value) so
 * a single bad credential never crashes a sync.
 */
export function decryptTokenSafe(value: string): string {
  if (!value.includes(':')) return value;
  try {
    return decryptToken(value);
  } catch {
    return value;
  }
}
