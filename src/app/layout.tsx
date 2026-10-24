import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tu semana en SF · SF Sidekick",
  description: "Un objetivo claro. Conversaciones que merecen la pena. Prepara tu estancia en San Francisco.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
