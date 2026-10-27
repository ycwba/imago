/* 拖拽边缘自动滚动（纯件，无 DOM 之外的手势辅助）—— 参考 lib/timelineEdgeAutoScroll.js：
   拖动时指针压到轨道区左右边缘，就按「压进去多深」比例持续横摇；每摇一帧回调一次，
   让调用方按**当前** scrollLeft 重算预览与吸附（指针坐标没变，内容动了）。
   Esc / 松手一律走 `stop()`（调用方在 pointerup / keydown 里叫）。 */

export const AUTOSCROLL_MARGIN = 48;
export const AUTOSCROLL_MAX_SPEED = 18;      // 每帧最多挪多少像素（按 60fps 计）

/* `viewport()` 返回当前滚动容器（坞每 3 秒重画，节点会换，所以传函数不传节点）。
   `onScroll(dx, scrollLeft)` 每帧一次；`dx = 0` 也会回调一次（表示这一帧没摇，用来收尾重画）。 */
export function createEdgeAutoScroll({ viewport, onScroll, margin = AUTOSCROLL_MARGIN, maxSpeed = AUTOSCROLL_MAX_SPEED } = {}) {
  let raf = 0;
  let lastX = null;
  let lastT = 0;

  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(tick);
  };

  const tick = t => {
    raf = 0;
    const el = viewport && viewport();
    if (!el || lastX == null) return;
    const rect = el.getBoundingClientRect();
    const m = Math.max(1, margin);
    let dir = 0, depth = 0;
    if (lastX < rect.left + m) { dir = -1; depth = (rect.left + m - lastX) / m; }
    else if (lastX > rect.right - m) { dir = 1; depth = (lastX - (rect.right - m)) / m; }
    const dt = lastT ? Math.max(4, Math.min(64, t - lastT)) : 16;
    lastT = t;
    if (!dir) { if (onScroll) onScroll(0, el.scrollLeft); return; }
    const speed = Math.min(1, depth) * maxSpeed * (dt / 16);
    const before = el.scrollLeft;
    el.scrollLeft = before + dir * speed;
    const dx = el.scrollLeft - before;
    if (onScroll) onScroll(dx, el.scrollLeft);
    /* 到底了（dx = 0）就停：不停会在边缘上空转，而且指针再动一次也照样会重新排帧。 */
    if (dx !== 0) schedule();
  };

  return {
    /* 指针移动时调；只在真的压到边缘时才排帧。 */
    update(clientX) {
      lastX = Number.isFinite(clientX) ? clientX : null;
      if (lastX == null) return;
      lastT = 0;
      schedule();
    },
    stop() {
      lastX = null;
      lastT = 0;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    get active() { return !!raf || lastX != null; },
  };
}
