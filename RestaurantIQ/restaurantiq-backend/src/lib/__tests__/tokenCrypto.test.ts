import { randomBytes } from 'crypto';
import {
  encryptToken,
  decryptToken,
  decryptTokenWithMeta,
  decryptTokenSafe,
} from '../tokenCrypto';

const KEY_V0 = randomBytes(32).toString('hex');
const KEY_V1 = randomBytes(32).toString('hex');
const KEY_V2 = randomBytes(32).toString('hex');

function setKeys(active: string, legacy: string[] = []): void {
  process.env.ACTIVE_TOKEN_ENCRYPTION_KEY = active;
  process.env.LEGACY_TOKEN_ENCRYPTION_KEYS = legacy.join(',');
  delete process.env.TOKEN_ENCRYPTION_KEY;
}

describe('tokenCrypto key rotation', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('round-trips a value under the active key', () => {
    setKeys(KEY_V2);
    const ciphertext = encryptToken('sq-access-token');
    expect(ciphertext.split(':')).toHaveLength(3);

    const result = decryptTokenWithMeta(ciphertext);
    expect(result.plaintext).toBe('sq-access-token');
    expect(result.usedActiveKey).toBe(true);
  });

  it('decrypts a value encrypted under a legacy key and flags migration', () => {
    setKeys(KEY_V1);
    const ciphertext = encryptToken('legacy-secret');

    // Rotate: V1 becomes legacy, V2 is the new active key.
    setKeys(KEY_V2, [KEY_V1]);

    const result = decryptTokenWithMeta(ciphertext);
    expect(result.plaintext).toBe('legacy-secret');
    expect(result.usedActiveKey).toBe(false);
  });

  it('tries multiple legacy keys in order', () => {
    setKeys(KEY_V0);
    const ciphertext = encryptToken('oldest-secret');

    setKeys(KEY_V2, [KEY_V1, KEY_V0]);

    const result = decryptTokenWithMeta(ciphertext);
    expect(result.plaintext).toBe('oldest-secret');
    expect(result.usedActiveKey).toBe(false);
  });

  it('supports the migration path: re-encrypt legacy value under active key', () => {
    setKeys(KEY_V1);
    const legacyCiphertext = encryptToken('migrate-me');

    setKeys(KEY_V2, [KEY_V1]);

    const decrypted = decryptTokenWithMeta(legacyCiphertext);
    expect(decrypted.usedActiveKey).toBe(false);

    // Caller re-encrypts; now it decrypts cleanly under the active key.
    const migrated = encryptToken(decrypted.plaintext);
    const after = decryptTokenWithMeta(migrated);
    expect(after.plaintext).toBe('migrate-me');
    expect(after.usedActiveKey).toBe(true);
  });

  it('throws a controlled error when no key matches', () => {
    setKeys(KEY_V1);
    const ciphertext = encryptToken('unreadable');

    // Rotate to an unrelated key with no legacy keys configured.
    setKeys(KEY_V2);

    expect(() => decryptToken(ciphertext)).toThrow(/no configured key matched/);
  });

  it('rejects malformed ciphertext', () => {
    setKeys(KEY_V2);
    expect(() => decryptToken('not-valid')).toThrow(/Invalid encrypted token format/);
  });

  it('falls back to TOKEN_ENCRYPTION_KEY when ACTIVE is unset', () => {
    delete process.env.ACTIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.LEGACY_TOKEN_ENCRYPTION_KEYS;
    process.env.TOKEN_ENCRYPTION_KEY = KEY_V1;
    const ciphertext = encryptToken('fallback-secret');
    expect(decryptToken(ciphertext)).toBe('fallback-secret');
  });

  it('throws when no key is configured at all', () => {
    delete process.env.ACTIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken('x')).toThrow(/is not set/);
  });

  describe('decryptTokenSafe', () => {
    it('returns plaintext for a non-encrypted value (no colon)', () => {
      setKeys(KEY_V2);
      expect(decryptTokenSafe('plain-token')).toBe('plain-token');
    });

    it('returns the raw value when decryption fails', () => {
      setKeys(KEY_V1);
      const ciphertext = encryptToken('secret');
      setKeys(KEY_V2); // no legacy → cannot decrypt
      expect(decryptTokenSafe(ciphertext)).toBe(ciphertext);
    });

    it('decrypts a valid value', () => {
      setKeys(KEY_V2);
      const ciphertext = encryptToken('secret');
      expect(decryptTokenSafe(ciphertext)).toBe('secret');
    });
  });
});
