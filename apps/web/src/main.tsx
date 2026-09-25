import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Missing #root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <h1>ENSmap</h1>
  </StrictMode>,
);
