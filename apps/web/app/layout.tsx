import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Slate",
  description: "Personal notes and project trackers that write READMEs and read agent plans back.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
