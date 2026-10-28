import crypto from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
};

const SCRYPT_PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_OPTIONS: crypto.ScryptOptions = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024
};

/**
 * Hashes a plaintext password using scrypt with a cryptographic salt.
 * Output format: `scrypt$<salt_hex>$<derived_key_hex>`
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string.");
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = (await scryptAsync(
    password,
    salt,
    KEY_BYTES,
    SCRYPT_OPTIONS
  )) as Buffer;

  return `${SCRYPT_PREFIX}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash in constant time.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash || typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) {
    return false;
  }

  const saltHex = parts[1];
  const hashHex = parts[2];

  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const storedKey = Buffer.from(hashHex, "hex");

  if (salt.length !== SALT_BYTES || storedKey.length !== KEY_BYTES) {
    return false;
  }

  try {
    const derivedKey = (await scryptAsync(
      password,
      salt,
      KEY_BYTES,
      SCRYPT_OPTIONS
    )) as Buffer;

    return crypto.timingSafeEqual(storedKey, derivedKey);
  } catch {
    return false;
  }
}
