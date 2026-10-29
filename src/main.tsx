import { createRoot } from 'react-dom/client';
import App, { ErrorBoundary } from './App';
import { initializeDesktopLifecycle } from './services/desktop';
import './styles.css';

initializeDesktopLifecycle();
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
