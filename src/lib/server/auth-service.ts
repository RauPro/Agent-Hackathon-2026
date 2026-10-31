import { emailSchema, signInCodeSchema } from "@/lib/domain/auth";
import { openCalendarData } from "./calendar-crypto";
import { revokeGoogleTokens, tokenDataSchema } from "./google-calendar";
import { AccountConflict, ContextStore } from "./store";
import { sendSignInCode, signInDelivery } from "./sign-in-email";
import { signInEmailLimits } from "./usage-limits";

export class SignInUnavailable extends Error {}

export async function requestSignInCode(
  store: ContextStore,
  email: string,
  previousToken?: string,
  ip?: string,
) {
  email = emailSchema.parse(email);
  if (await store.account(previousToken)) throw new AccountConflict();
  const delivery = signInDelivery();
  if (delivery === "unconfigured") throw new SignInUnavailable();
  await store.reserveAuthAttempt(email, Date.now(), ip);
  if (delivery === "email") await store.reserveUsage(signInEmailLimits());
  const code = await store.issueSignInCode(email);
  if (delivery === "inline") {
    console.info(`sign_in_code ${email} ${code}`);
    return { devCode: code };
  }
  try {
    await sendSignInCode(email, code);
  } catch {
    throw new SignInUnavailable();
  }
  return {};
}

export async function verifySignIn(
  store: ContextStore,
  email: string,
  code: string,
  previousToken?: string,
) {
  email = emailSchema.parse(email);
  if (await store.account(previousToken)) throw new AccountConflict();
  await store.verifySignInCode(email, signInCodeSchema.parse(code));
  return store.continueAccount(email, previousToken, true);
}

// Local data is removed first; Google revocation is best effort afterwards.
export async function deleteAccount(store: ContextStore, token: string | undefined) {
  const account = await store.requireAccount(token);
  const record = await store.readCalendar(token);
  const owner = await store.calendarOwner(token);
  await store.deleteAccount(account.id);
  if (!record.connection) return;
  try {
    await revokeGoogleTokens(
      tokenDataSchema.parse(openCalendarData(record.connection.encryptedTokens, owner)),
    );
  } catch {
    console.error("account_delete_revoke_failed");
  }
}
