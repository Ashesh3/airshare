import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** 22 unbiased base58 characters (about 128.9 bits); bytes of 232 or more are rejected to avoid modulo bias. */
export function randomKey(length = 22) {
  let key = "";
  while (key.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2)))
      if (byte < 232 && key.length < length) key += BASE58[byte % 58];
  }
  return key;
}
/** The only form in which a capability key is stored or looked up. */
export function keyHash(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

// Domain-separated from keyHash: the stored hash must not open anything.
function sealingKey(under: string) {
  return createHash("sha256").update("airshare-seal-v1:").update(under).digest();
}

/** Encrypts one key under another, so whoever holds the outer key can recover the inner one after a restart. */
export function seal(key: string, under: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(under), iv);
  const sealed = Buffer.concat([iv, cipher.update(key, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return sealed.toString("base64url");
}

export function unseal(sealed: string, under: string) {
  const bytes = Buffer.from(sealed, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(under), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
}
