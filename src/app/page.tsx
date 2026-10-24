import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/server/current-account";

export const dynamic = "force-dynamic";
export default async function Page() {
  redirect((await currentAccount()) ? "/onboarding" : "/register");
}
