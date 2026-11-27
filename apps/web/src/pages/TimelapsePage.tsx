/**
 * `/timelapse`: the village growing from day one. The timeline (`/api/public/timeline`) is replayed on a small
 * canvas of the village, using the same procedural art as the live map, with a scrubber, play/pause and speed.
 */
import type { TimelineEntry } from '@ajwf/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseTimeline } from '../data/api';
import { drawMockSheet } from '../data/mockSprites';
import { useT } from '../i18n/store';
import { type Baked, bakeMap } from '../map/art/bake';
import * as A from '../map/art/props';
import { TILE } from '../map/geometry';
import { type ApiState, EmptyState, ErrorState, Loading, PageShell, useApi } from '../ui/common';
import { useApp } from '../ui/context';
import { fmtDateTime } from '../view/format';
import { replaySpan, type ReplayState, replayUntil, sortTimeline } from '../view/timelapse';
import { timelineText } from './VillagePage';

const SPEEDS = [1, 2, 4] as const;
/** A full replay lasts this long at 1x. */
const BASE_MS = 45_000;

export default function TimelapsePage() {
  const state = useApi('/api/public/timeline', (b) => parseTimeline(b));
  return <TimelapseView state={state} />;
}

export function TimelapseView({ state }: { state: ApiState<TimelineEntry[]> }) {
  const tr = useT();
  return (
    <PageShell title={tr.t('ui.timelapse.title')} kicker={tr.t('ui.timelapse.kicker')} wide>
      {state.status === 'loading' ? <Loading /> : null}
      {state.status === 'error' ? <ErrorState /> : null}
      {state.status === 'ready' && state.data.length === 0 ? (
        <EmptyState icon="hammer" title={tr.t('ui.timelapse.empty')} body={tr.t('ui.timelapse.empty_body')} />
      ) : null}
      {state.status === 'ready' && state.data.length > 0 ? <Player entries={state.data} /> : null}
    </PageShell>
  );
}

function Player({ entries }: { entries: TimelineEntry[] }) {
  const tr = useT();
  const sorted = useMemo(() => sortTimeline(entries), [entries]);
  const [t0, t1] = useMemo(() => replaySpan(sorted), [sorted]);
  const [t, setT] = useState(t0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      setT((cur) => {
        const next = cur + ((t1 - t0) / BASE_MS) * speed * dt;
        if (next >= t1) {
          setPlaying(false);
          return t1;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, t0, t1]);

  useEffect(() => {
    if (reduced) {
      setPlaying(false);
      setT(t1);
    }
  }, [reduced, t1]);

  const replay = useMemo(() => replayUntil(sorted, t), [sorted, t]);
  const built = [...replay.projects.values()].filter((p) => p.done).length;
  return (
    <div className="timelapse">
      <VillageCanvas replay={replay} />
      <div className="tl-controls pixel-box">
        <button
          type="button"
          className="btn btn-primary tl-play"
          onClick={() => {
            if (!playing && t >= t1) setT(t0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? tr.t('ui.timelapse.pause') : tr.t('ui.timelapse.play')}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <input
          className="tl-scrub"
          type="range"
          min={t0}
          max={t1}
          step={Math.max(1, Math.round((t1 - t0) / 1000))}
          value={Math.round(t)}
          aria-label={tr.t('ui.timelapse.scrub')}
          aria-valuetext={fmtDateTime(tr.lang, t)}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
        />
        <div className="tl-speed" role="group" aria-label={tr.t('ui.timelapse.speed')}>
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={`tab ${s === speed ? 'is-on' : ''}`} aria-pressed={s === speed} onClick={() => setSpeed(s)}>
              {tr.t('ui.timelapse.speed_x', { n: s })}
            </button>
          ))}
        </div>
      </div>
      <div className="tl-status">
        <span className="tl-time">{fmtDateTime(tr.lang, t)}</span>
        <span className="muted small">{tr.t('ui.timelapse.built', { n: built })}</span>
        <span className="tl-caption" aria-live="polite">
          {replay.last ? timelineText(tr, replay.last) : tr.t('ui.timelapse.start')}
        </span>
      </div>
    </div>
  );
}

type Pic = { canvas: HTMLCanvasElement; ax: number; ay: number };

/** The village drawn with the live map's art: baked ground once, then every site from the replay state. */
function VillageCanvas({ replay }: { replay: ReplayState }) {
  const { world } = useApp();
  const tr = useT();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const baked = useMemo<Baked | null>(() => {
    try {
      const rooms = world.rooms.filter((r) => r.zone === 'village');
      return bakeMap(rooms, world, 2048);
    } catch {
      return null;
    }
  }, [world]);
  const pics = useRef(new Map<string, Pic>());
  const statue = useRef<HTMLCanvasElement | null>(null);

  // Crop to the village with a little margin.
  const view = useMemo(() => {
    const rooms = world.rooms.filter((r) => r.zone === 'village');
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rooms) {
      x0 = Math.min(x0, r.rect[0]);
      y0 = Math.min(y0, r.rect[1]);
      x1 = Math.max(x1, r.rect[0] + r.rect[2]);
      y1 = Math.max(y1, r.rect[1] + r.rect[3]);
    }
    return { x: (x0 - 1) * TILE, y: (y0 - 4) * TILE, w: (x1 - x0 + 2) * TILE, h: (y1 - y0 + 5) * TILE };
  }, [world]);

  useEffect(() => {
    // measure the column, not the stage: the stage shrinks to the canvas
    const el = host.current?.parentElement;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !baked) return;
    // fit the width, but keep the controls in view on short screens
    const fitH = Math.max(300, window.innerHeight - 290) * (view.w / view.h);
    const scale = Math.min(width, fitH) / view.w;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(view.w * scale * dpr);
    c.height = Math.round(view.h * scale * dpr);
    c.style.width = `${Math.round(view.w * scale)}px`;
    c.style.height = `${Math.round(view.h * scale)}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, -view.x * scale * dpr, -view.y * scale * dpr);
    ctx.fillStyle = '#1b1726';
    ctx.fillRect(view.x, view.y, view.w, view.h);
    for (const ch of baked.chunks) ctx.drawImage(ch.canvas, ch.x, ch.y);
    const pic = (key: string, make: () => A.Art): Pic => {
      let p = pics.current.get(key);
      if (!p) {
        const a = make();
        p = { canvas: a.buf.toCanvas(), ax: a.ax, ay: a.ay };
        pics.current.set(key, p);
      }
      return p;
    };
    const drawPic = (p: Pic, x: number, y: number) => ctx.drawImage(p.canvas, Math.round(x - p.ax), Math.round(y - p.ay));
    const byPlot = new Map([...replay.projects.values()].map((p) => [p.plot, p]));
    for (const [roomId, site] of Object.entries(baked.sites)) {
      const proj = byPlot.get(roomId);
      const hall = replay.halls.get(roomId);
      const variant = baked.variants[roomId];
      const building = proj?.building ?? world.projects.find((p) => p.site === roomId)?.building ?? '';
      if (hall) {
        drawPic(pic(`hall:${hall.guild}:${hall.colors.join()}`, () => A.guildHall(A.hexColor(hall.colors[0]), A.hexColor(hall.colors[1], 0xf2b84b))), site.x, site.y + 4);
        continue;
      }
      if (variant) {
        const v = proj?.done ? variant.done : variant.base;
        drawPic({ canvas: pic(`variant:${roomId}:${proj?.done ? 1 : 0}`, () => v.art).canvas, ax: v.art.ax, ay: v.art.ay }, v.x, v.y);
        if (proj?.done && variant.statueAt) {
          if (!statue.current) {
            const src = document.createElement('canvas');
            src.width = 20;
            src.height = 28;
            const sctx = src.getContext('2d');
            if (sctx) {
              sctx.drawImage(drawMockSheet('placeholder-silhouette'), 0, 0, 20, 28, 0, 0, 20, 28);
              const b = A.bronzeFrame(sctx.getImageData(0, 0, 20, 28).data);
              b.outline();
              statue.current = b.toCanvas();
            }
          }
          if (statue.current) ctx.drawImage(statue.current, Math.round(variant.statueAt.x - 10), Math.round(variant.statueAt.y - 27));
        }
      }
      const work = proj && !proj.done && proj.progress > 0;
      if (!variant) {
        if (proj?.done)
          drawPic(
            pic(`done:${building}`, () => (building === 'bridge' && baked.bridge ? A.bridge(baked.bridge.w + 8, baked.bridge.h + 8) : A.projectBuilding(building))),
            site.x,
            site.y,
          );
        else if (!work && site.plot) drawPic(pic(`lot:${roomId}`, () => A.emptyLot(Math.min(site.w, 124), 54)), site.x, site.y);
      }
      if (work) {
        drawPic(pic(`work:${roomId}`, () => A.scaffold(Math.min(site.w, roomId === 'village.river_bank' ? 52 : 120), Math.min(site.h, 52), roomId.length * 7919)), site.x, site.y);
        const w = 44;
        const x = Math.round(site.x - w / 2);
        const y = Math.round(site.y - Math.min(site.h, 52) - 10);
        ctx.fillStyle = '#241a2e';
        ctx.fillRect(x - 1, y - 1, w + 2, 7);
        ctx.fillStyle = '#4a3d66';
        ctx.fillRect(x, y, w, 5);
        ctx.fillStyle = '#f2b84b';
        ctx.fillRect(x, y, Math.round(w * proj.progress), 5);
      }
    }
  }, [baked, replay, width, view, world]);

  return (
    <div className="tl-stage pixel-box" ref={host}>
      {baked ? <canvas ref={canvas} role="img" aria-label={tr.t('ui.timelapse.canvas_label')} /> : <Loading />}
    </div>
  );
}
