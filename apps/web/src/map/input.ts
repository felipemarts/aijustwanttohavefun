/** Pan (drag, touch, inertia), zoom (wheel, trackpad pinch, touch pinch, keys) and tap, on the canvas element. */
import type { Camera } from './camera';

export type InputHandlers = {
  /** Any manual camera change (pauses the director, drops follow on pan). */
  manual(kind: 'pan' | 'zoom'): void;
  tap(sx: number, sy: number): void;
};

export function attachInput(el: HTMLElement, cam: Camera, h: InputHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let start: { x: number; y: number; t: number } | null = null;
  let moved = false;
  let pinch: { dist: number; scale: number; mx: number; my: number } | null = null;
  let last = { x: 0, y: 0, t: 0 };
  let vel = { x: 0, y: 0 };
  let wheelAcc = 0;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    el.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    cam.stop();
    if (pointers.size === 1) {
      start = { x: p.x, y: p.y, t: performance.now() };
      last = { ...start };
      moved = false;
      vel = { x: 0, y: 0 };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: cam.scale,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
      moved = true;
    }
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      cam.panBy(mx - pinch.mx, my - pinch.my);
      cam.zoomAt(pinch.scale * (dist / pinch.dist), mx, my);
      pinch.mx = mx;
      pinch.my = my;
      h.manual('zoom');
      return;
    }
    if (!start) return;
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 6) {
      moved = true;
      h.manual('pan');
    }
    if (moved) {
      cam.panBy(p.x - prev.x, p.y - prev.y);
      const now = performance.now();
      const dt = Math.max(1, now - last.t);
      vel = {
        x: 0.7 * vel.x + 0.3 * (((p.x - last.x) / dt) * 1000),
        y: 0.7 * vel.y + 0.3 * (((p.y - last.y) / dt) * 1000),
      };
      last = { x: p.x, y: p.y, t: now };
    }
  };

  const onUp = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        cam.snapZoom();
        start = null;
      }
      return;
    }
    if (!start || !p) return;
    if (!moved && performance.now() - start.t < 600) h.tap(p.x, p.y);
    else if (
      moved &&
      performance.now() - last.t < 80 &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      cam.fling(vel.x, vel.y);
    start = null;
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    h.manual('zoom');
    if (e.ctrlKey) {
      // trackpad pinch: continuous, then snap to a crisp step
      cam.zoomAt(cam.scale * Math.exp(-e.deltaY * 0.01), p.x, p.y);
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => cam.snapZoom(p.x, p.y), 220);
      return;
    }
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(wheelAcc) >= 50) {
      cam.stepZoom(wheelAcc < 0 ? 1 : -1, p.x, p.y);
      wheelAcc = 0;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    )
      return;
    const pan = 80;
    switch (e.key) {
      case '+':
      case '=':
        h.manual('zoom');
        cam.stepZoom(1);
        break;
      case '-':
      case '_':
        h.manual('zoom');
        cam.stepZoom(-1);
        break;
      case 'ArrowLeft':
        h.manual('pan');
        cam.panBy(pan, 0);
        break;
      case 'ArrowRight':
        h.manual('pan');
        cam.panBy(-pan, 0);
        break;
      case 'ArrowUp':
        h.manual('pan');
        cam.panBy(0, pan);
        break;
      case 'ArrowDown':
        h.manual('pan');
        cam.panBy(0, -pan);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('wheel', onWheel);
    window.removeEventListener('keydown', onKey);
    if (snapTimer) clearTimeout(snapTimer);
  };
}
