import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { registerMessagingServiceWorker } from './firebase.js';

registerMessagingServiceWorker()
  .then(() => console.log('[FCM] Service worker registered'))
  .catch((error) => {
    console.warn('Service worker registration failed:', error);
  });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
