import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class Boundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: any) { console.error('[ui] render error', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 32, color: '#e8eaed', background: '#17191d', height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0 }}>界面出错了</h2>
          <div style={{ color: '#9aa1ac', fontSize: 13 }}>可以点下面按钮重新载入；如果反复出现，请把这段信息反馈给作者。</div>
          <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '45vh', overflow: 'auto', background: '#0f1115', padding: 12, borderRadius: 8, fontSize: 11 }}>
            {String(this.state.err?.stack || this.state.err)}
          </pre>
          <div>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #33373f', background: '#262a31', color: '#e8eaed', cursor: 'pointer' }}>
              重新载入
            </button>
          </div>
        </div>
      );
    }
    return this.props.children as any;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </React.StrictMode>
);
