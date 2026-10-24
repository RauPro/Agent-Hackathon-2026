import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentAccount } from "@/lib/server/current-account";
import { authReturnPath } from "@/lib/domain/auth-return";
export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · SF Sidekick" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = authReturnPath((await searchParams).next);
  if (await currentAccount()) redirect(next);
  return <AuthForm mode="login" next={next} />;
}
