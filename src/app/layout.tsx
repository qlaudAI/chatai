import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'chatai — open-source AI chat on qlaud',
  description:
    'Production-quality chat app built on qlaud + Clerk. Fork it, swap env vars, deploy.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${inter.variable} h-full antialiased`}>
        <body className="min-h-full bg-background text-foreground font-sans">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
