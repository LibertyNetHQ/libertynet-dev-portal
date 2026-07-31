import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { SessionProvider } from "./components/SessionProvider";
import { Masthead } from "./components/Masthead";

export const metadata: Metadata = {
  title: "LibertyNet — Developer Dashboard",
  description:
    "Your operator account and the live LibertyNet network. Every identity verified in your own browser.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <div className="shell">
            <Masthead />
            <main>{children}</main>
          </div>
        </SessionProvider>
      </body>
    </html>
  );
}
