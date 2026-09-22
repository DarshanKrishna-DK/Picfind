import { useQuery } from '@tanstack/react-query';
import { api, type Library } from './api';
export const useLibrary = (enabled = true) =>
  useQuery({
    queryKey: ['library'],
    queryFn: () => api<Library>('/library'),
    enabled,
  });
