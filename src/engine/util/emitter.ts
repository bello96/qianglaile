/** 最小的发布-订阅。on() 返回取消订阅的函数。 */
export class Emitter<T> {
  private listeners: ((v: T) => void)[] = [];

  on(cb: (v: T) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  emit(v: T): void {
    // 遍历快照：回调里取消订阅不会打乱本次分发
    for (const l of [...this.listeners]) l(v);
  }

  clear(): void {
    this.listeners = [];
  }
}
