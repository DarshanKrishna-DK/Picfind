import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/manrope';
import { Product } from './product';
import './product.css';
import './gallery-experience.css';
import './landing.css';
import './studio.css';
import { ProductBoundary } from './components/error-boundary';
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15000 },
  },
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ProductBoundary>
          <Product />
        </ProductBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
