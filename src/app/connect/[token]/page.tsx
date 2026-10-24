import { redirect } from "next/navigation";
import { ConnectPreview } from "@/components/network";
import { currentAccount } from "@/lib/server/current-account";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const account = await currentAccount();
  if (!account)
    redirect(`/login?next=${encodeURIComponent(`/connect/${token}`)}`);
  return <ConnectPreview account={account} token={token} />;
}
