import { useEffect, useRef } from 'react';
import { useApp } from './context';

/** Draws frame 0 of a character sheet, scaled up with crisp pixels. Works for server PNGs and mock canvases. */
export function SpriteFrame({
  hash,
  scale = 4,
  npc = false,
}: {
  hash: string;
  scale?: number;
  npc?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { source } = useApp();
  useEffect(() => {
    let alive = true;
    void (npc ? source.npcSpriteImage(hash) : source.spriteImage(hash)).then((img) => {
      const c = ref.current;
      if (!alive || !c || !img) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.width, c.height);
      try {
        ctx.drawImage(img, 0, 0, 20, 28, 0, 0, 20, 28);
      } catch {
        // broken image: leave the frame empty
      }
    });
    return () => {
      alive = false;
    };
  }, [hash, npc, source]);
  return (
    <canvas
      ref={ref}
      width={20}
      height={28}
      className="sprite-frame"
      style={{ width: 20 * scale, height: 28 * scale }}
      aria-hidden="true"
    />
  );
}
