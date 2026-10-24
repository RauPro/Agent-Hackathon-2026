import { cookies } from "next/headers";
import { getStore } from "./store";
import { SESSION_COOKIE } from "./http";

export async function currentAccount() {
  return getStore().account((await cookies()).get(SESSION_COOKIE)?.value);
}
