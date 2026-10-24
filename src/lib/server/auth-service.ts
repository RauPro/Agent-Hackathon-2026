import { authRequestSchema } from "@/lib/domain/auth";
import { AccountConflict, ContextStore } from "./store";

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
  // Successful access counts too: this controlled MVP does not verify ownership.
  return store.continueAccount(request.email, previousToken);
}
