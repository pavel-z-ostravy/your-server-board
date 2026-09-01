import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyHash(pw, stored) {
  if (typeof pw !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  try {
    const [, n, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    if (expected.length !== KEYLEN) return false;
    const actual = await scrypt(pw, salt, KEYLEN, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
