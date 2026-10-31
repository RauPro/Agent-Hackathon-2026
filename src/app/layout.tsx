import type { Metadata } from "next";
import "./globals.css";

const description =
  "Your AI agent finds the SF events worth attending and coordinates meetings with other people's agents. You approve every step.";
const productionHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL || "sf-sidekick-raupro.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(`https://${productionHost}`),
  title: "SF Sidekick · Meet the people who matter in SF",
  description,
  openGraph: {
    title: "SF Sidekick",
    description,
    siteName: "SF Sidekick",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "SF Sidekick", description },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
