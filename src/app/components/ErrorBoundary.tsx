import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 兜底：页面里任何一处的代码出了错，都落到这里，换成一张说明卡片——而不是整页变成空白。
 * 出错的那部分页面会被卸掉，摄像头也随之关闭。
 *
 * （React 里只有类组件能接住子组件渲染时抛出的错误，所以这里是全项目唯一的类组件。）
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] 页面出错了：', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const home = (): void => {
      window.location.hash = '/';
      window.location.reload();
    };
    return (
      <div className="screen">
        <div className="plate center-card" role="alert">
          <h2>页面出错了</h2>
          <p>这是程序的毛病，不是你哪里操作错了。刷新一下通常就好。</p>
          <p style={{ fontSize: 'var(--t-small)' }}>{error.message}</p>
          <div className="center-card__actions">
            <button type="button" className="btn btn--go" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button type="button" className="btn" onClick={home}>
              回首页
            </button>
          </div>
        </div>
      </div>
    );
  }
}
