'use client';
import { ThemeProvider } from 'next-themes';
import { MotionConfig } from 'motion/react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TRPCProvider } from '@/trpc/client';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
        <TRPCProvider>
          <TooltipProvider delay={250}>{children}</TooltipProvider>
        </TRPCProvider>
        <Toaster position="bottom-right" />
      </MotionConfig>
    </ThemeProvider>
  );
}
