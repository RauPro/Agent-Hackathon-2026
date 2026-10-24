import { redirect } from "next/navigation";
import { Network } from "@/components/network";
import { currentAccount } from "@/lib/server/current-account";

export const dynamic = "force-dynamic";

export default async function Page() {
  const account = await currentAccount();
  if (!account) redirect("/login?next=%2Fnetwork");
  return <Network account={account} />;
}
