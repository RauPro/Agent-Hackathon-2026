import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { currentAccount } from "@/lib/server/current-account";
export const dynamic = "force-dynamic";
export const metadata = { title: "Create account · SF Sidekick" };
export default async function Page() {
  if (await currentAccount()) redirect("/onboarding");
  return <AuthForm mode="register" />;
}
