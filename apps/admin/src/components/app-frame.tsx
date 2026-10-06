'use client';

/**
 * The gate. No session means the login screen and nothing else: an operator
 * panel must not render a shell that hints at what it contains.
 */

import type { ReactNode } from 'react';
import { useApp } from '@/lib/app-context';
import { LoginScreen } from './login';
import { Page, Sidebar, TopBar } from './shell';
import { Spinner, ToastStack } from './ui';

export function AppFrame({ children }: { children: ReactNode }) {
  const { principal, ready, toasts, dismissToast } = useApp();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size={20} className="text-[var(--fg-faint)]" />
      </div>
    );
  }

  if (!principal) {
    return (
      <>
        <LoginScreen />
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="pl-[216px]">
        <TopBar />
        <main>
          <Page>{children}</Page>
        </main>
      </div>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
