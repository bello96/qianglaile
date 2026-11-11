// 样式表要排在 App 前面：样式谁后加载谁说了算，基础样式得先到，页面自己的样式（随 App 一起进来）才能在它上面改
import '@fontsource/zcool-qingke-huangyou';
import './app/styles/tokens.css';
import './app/styles/base.css';
import './app/styles/components.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './app/components/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
