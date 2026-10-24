import { redirect } from "next/navigation";
import { Onboarding } from "@/components/onboarding";
import { currentAccount } from "@/lib/server/current-account";
export const dynamic = "force-dynamic";
export default async function Page() {
  const account = await currentAccount();
  if (!account) redirect("/register");
  return <Onboarding account={account} />;
}
