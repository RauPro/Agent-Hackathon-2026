import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { authRequestSchema } from "@/lib/domain/auth";
import { AccountConflict, AuthRateLimit, ContextStore } from "./store";

const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const FORMAT = "scrypt-v1";
const DUMMY_HASH = `${FORMAT}$${"0".repeat(32)}$${"0".repeat(128)}`;
let hashing = 0;
export class InvalidCredentials extends Error {}

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, "hex"),
      64,
      SCRYPT_OPTIONS,
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${FORMAT}$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [format, salt, key] = encoded.split("$");
  if (
    format !== FORMAT ||
    !/^[a-f0-9]{32}$/.test(salt || "") ||
    !/^[a-f0-9]{128}$/.test(key || "")
  )
    return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, "hex"));
}

export async function authenticate(
  store: ContextStore,
  input: unknown,
  previousToken?: string,
) {
  const request = authRequestSchema.parse(input);
  if (request.action === "logout") {
    await store.logout(previousToken);
    return null;
  }
  if (await store.account(previousToken)) throw new AccountConflict();
  await store.reserveAuthAttempt(request.email);
  if (hashing >= 2) throw new AuthRateLimit();
  hashing++;
  try {
    if (request.action === "register") {
      // Hash before the uniqueness check so existing addresses do not get a fast path.
      const passwordHash = await hashPassword(request.password);
      const result = await store.registerAccount(
        request.email,
        passwordHash,
        previousToken,
      );
      await store.clearAuthAttempts(request.email);
      return result;
    }
    const credentials = await store.credentials(request.email);
    const verified = await verifyPassword(
      request.password,
      credentials?.password_hash ?? DUMMY_HASH,
    );
    if (!verified || !credentials) throw new InvalidCredentials();
    const token = await store.createLogin(credentials.id);
    await store.clearAuthAttempts(request.email);
    return { token, account: await store.requireAccount(token) };
  } finally {
    hashing--;
  }
}
