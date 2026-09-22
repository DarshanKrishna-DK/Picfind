import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export interface AccountCapabilities {
  google: boolean;
  recovery: boolean;
  verification: boolean;
  deletion: boolean;
}

export function useAccountCapabilities() {
  return useQuery({
    queryKey: ['account-capabilities'],
    queryFn: () => api<AccountCapabilities>('/account/capabilities'),
    staleTime: 60_000,
  });
}

export function useAccountAction() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState('');
  async function run(operation: () => Promise<void>, success: string) {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await operation();
      setMessage(success);
      return true;
    } catch (failure) {
      setError(failure);
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return { busy, error, message, run };
}
