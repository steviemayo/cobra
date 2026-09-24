import type { Metadata } from 'next';
import './globals.css';
import { TRPCProvider } from '@/trpc/client';

export const metadata: Metadata = {
  title: 'Kestrel',
  description: 'AV control deployment and monitoring',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
