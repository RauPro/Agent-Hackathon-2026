import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Your plans in SF · SF Sidekick",
  description:
    "Plan your time in San Francisco around the conversations that matter to you.",
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
