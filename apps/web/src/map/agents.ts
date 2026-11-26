/**
 * Agents on the map: one view per agent with its sprite, shadow and far-zoom dot. Positions are pure functions of
 * time (a route and a start time), so off-screen agents cost nothing until they come into view.
 */
import type { AgentPos, RoomInfo } from '@ajwf/shared';
import type { Container } from 'pixi.js';
import { Sprite, type Texture } from 'pixi.js';
import { hash32 } from '../util/rng';
import { classColor } from './art/palette';
import type { SpriteAtlas } from './atlas';
import { agentSpot, pointAlong, type Pt, type Rect, roomPx, routeLength, walkRoute } from './geometry';
import type { Lod } from './lod';
import type { SceneTextures } from './textures';

const WALK_SPEED = 46; // px per second
const MAX_WALK_MS = 6500;

export type AgentView = {
  name: string;
  pos: AgentPos;
  sprite: Sprite;
  shadow: Sprite;
  dot: Sprite;
  textures: Texture[] | null;
  x: number;
  y: number;
  route: Pt[] | null;
  routeLen: number;
  routeT0: number;
  routeDur: number;
  /** Drop-in animation start (arrival), 0 when none. */
  dropAt: number;
  /** Fade: >0 fading in since, <0 fading out since (negated time). */
  fadeIn: number;
  fadeOutAt: number;
  hitUntil: number;
  phase: number;
  visible: boolean;
  facing: 1 | -1;
};

export class AgentLayer {
  readonly views = new Map<string, AgentView>();
  private tmp: Pt = { x: 0, y: 0 };
  visibleCount = 0;

  constructor(
    private readonly entities: Container,
    private readonly shadows: Container,
    private readonly dots: Container,
    private readonly tex: SceneTextures,
    private readonly atlas: SpriteAtlas,
    private readonly loadSprite: (hash: string) => Promise<CanvasImageSource | null>,
    private readonly reducedMotion: boolean,
  ) {}

  /** Reconciles views with the store's agents. */
  sync(agents: Map<string, AgentPos>, rooms: Map<string, RoomInfo>, now: number, arrivals: Set<string>) {
    for (const [name, pos] of agents) {
      const room = rooms.get(pos.r);
      if (!room) continue;
      let v = this.views.get(name);
      if (!v) {
        v = this.create(pos, room, now);
        if (arrivals.has(name) && !this.reducedMotion) v.dropAt = now;
        continue;
      }
      if (v.fadeOutAt) {
        v.fadeOutAt = 0;
        v.fadeIn = now;
      }
      const prevRoom = v.pos.r;
      const prevHash = v.pos.s;
      v.pos = pos;
      if (prevHash !== pos.s) this.loadTextures(v);
      v.dot.tint = classColor(pos.c);
      if (prevRoom !== pos.r) this.walk(v, rooms.get(prevRoom), room, now);
    }
    for (const v of this.views.values()) if (!agents.has(v.name) && !v.fadeOutAt) v.fadeOutAt = now;
  }

  private create(pos: AgentPos, room: RoomInfo, now: number): AgentView {
    const spot = agentSpot(room, pos.n);
    const sprite = new Sprite(this.tex.placeholder[0]);
    sprite.anchor.set(0.5, 1);
    sprite.alpha = 0;
    const shadow = new Sprite(this.tex.fx.shadow);
    shadow.anchor.set(0.5, 0.5);
    const dot = new Sprite(this.tex.fx.dot);
    dot.anchor.set(0.5, 0.5);
    dot.tint = classColor(pos.c);
    dot.visible = false;
    this.entities.addChild(sprite);
    this.shadows.addChild(shadow);
    this.dots.addChild(dot);
    const v: AgentView = {
      name: pos.n,
      pos,
      sprite,
      shadow,
      dot,
      textures: null,
      x: spot.x,
      y: spot.y,
      route: null,
      routeLen: 0,
      routeT0: 0,
      routeDur: 0,
      dropAt: 0,
      fadeIn: now,
      fadeOutAt: 0,
      hitUntil: 0,
      phase: (hash32(pos.n, 3) % 1000) / 1000,
      visible: false,
      facing: 1,
    };
    this.views.set(pos.n, v);
    this.loadTextures(v);
    return v;
  }

  private loadTextures(v: AgentView) {
    const hash = v.pos.s;
    if (!hash) return;
    void this.atlas
      .ensure(`a:${hash}`, () => this.loadSprite(hash))
      .then((t) => {
        if (t && v.pos.s === hash) v.textures = t;
      });
  }

  private walk(v: AgentView, from: RoomInfo | undefined, to: RoomInfo, now: number) {
    const start = this.positionAt(v, now, { x: 0, y: 0 });
    const end = agentSpot(to, v.name);
    v.route = null;
    if (from) {
      const route = walkRoute(roomPx(from), roomPx(to), start, end);
      if (route) {
        const len = routeLength(route);
        v.route = route;
        v.routeLen = len;
        v.routeT0 = now;
        v.routeDur = Math.min(MAX_WALK_MS, (len / WALK_SPEED) * 1000);
        v.x = end.x;
        v.y = end.y;
        return;
      }
    }
    // Not a neighbour (respawn, long move): pop out and drop in at the destination.
    v.x = end.x;
    v.y = end.y;
    if (!this.reducedMotion) v.dropAt = now;
  }

  /** Feet position at time `now`. */
  positionAt(v: AgentView, now: number, out: Pt): Pt {
    if (v.route) {
      const f = (now - v.routeT0) / v.routeDur;
      if (f >= 1) {
        v.route = null;
      } else {
        return pointAlong(v.route, Math.max(0, f) * v.routeLen, out);
      }
    }
    out.x = v.x;
    out.y = v.y;
    return out;
  }

  isWalking(v: AgentView, now: number) {
    return !!v.route && now - v.routeT0 < v.routeDur;
  }

  /** Per-frame update of visible agents. Returns the number visible. */
  update(now: number, view: Rect, lod: Lod, scale: number) {
    let visible = 0;
    const dotScale = Math.max(1, 1.1 / scale);
    for (const v of this.views.values()) {
      // fades
      let alpha = 1;
      if (v.fadeOutAt) {
        alpha = 1 - (now - v.fadeOutAt) / 500;
        if (alpha <= 0) {
          this.remove(v);
          continue;
        }
      } else if (v.fadeIn) {
        alpha = Math.min(1, (now - v.fadeIn) / 400);
        if (alpha >= 1) v.fadeIn = 0;
      }
      const p = this.positionAt(v, now, this.tmp);
      const inView = p.x > view.x && p.x < view.x + view.w && p.y > view.y && p.y < view.y + view.h + 30;
      v.visible = inView;
      if (!inView) {
        if (v.sprite.visible) v.sprite.visible = false;
        if (v.shadow.visible) v.shadow.visible = false;
        if (v.dot.visible) v.dot.visible = false;
        continue;
      }
      visible++;
      if (lod === 'dot') {
        v.sprite.visible = false;
        v.shadow.visible = false;
        v.dot.visible = true;
        v.dot.position.set(p.x, p.y - 8);
        v.dot.scale.set(dotScale);
        v.dot.alpha = alpha * (v.pos.f?.includes('d') ? 0.5 : 1);
        continue;
      }
      v.dot.visible = false;
      v.sprite.visible = true;
      v.shadow.visible = true;
      const fallen = !!v.pos.f?.includes('d');
      const walking = this.isWalking(v, now);
      let frame = 0;
      let lift = 0;
      if (walking && v.route) {
        frame = Math.floor((now - v.routeT0) / 160) % 2 ? 1 : 2;
        const ahead = pointAlong(
          v.route,
          Math.min(v.routeLen, ((now - v.routeT0) / v.routeDur) * v.routeLen + 4),
          { x: 0, y: 0 },
        );
        if (Math.abs(ahead.x - p.x) > 0.5) v.facing = ahead.x < p.x ? -1 : 1;
      } else if (!fallen) {
        const t = now / 1000 + v.phase * 7;
        // blink for 150 ms every few seconds; a 1 px idle bob
        if (t % (3 + v.phase * 3) < 0.15) frame = 3;
        if (!this.reducedMotion && Math.floor(t * 1.6 + v.phase * 10) % 2 === 0) lift = 1;
      }
      if (v.dropAt) {
        const f = (now - v.dropAt) / 450;
        if (f >= 1) v.dropAt = 0;
        else lift += Math.round((1 - f) * (1 - f) * 70);
      }
      const tex = v.textures ?? this.tex.placeholder;
      const s = v.sprite;
      s.texture = tex[frame] ?? tex[0]!;
      s.scale.x = v.facing;
      if (fallen) {
        s.rotation = -Math.PI / 2;
        s.position.set(Math.round(p.x) - 12, Math.round(p.y) - 4);
        s.tint = 0x9a98a8;
        s.alpha = alpha * 0.85;
      } else {
        s.rotation = 0;
        s.position.set(Math.round(p.x), Math.round(p.y) - lift);
        s.tint = now < v.hitUntil ? 0xff9a8a : v.textures ? 0xffffff : 0x8a8898;
        s.alpha = v.textures ? alpha : alpha * 0.6;
      }
      s.zIndex = Math.round(p.y);
      v.shadow.position.set(Math.round(p.x), Math.round(p.y));
      v.shadow.alpha = alpha * (lift > 4 ? 0.5 : 1);
    }
    this.visibleCount = visible;
    return visible;
  }

  /** Front-most agent under a world point. */
  hitTest(wx: number, wy: number, lod: Lod, scale: number, now: number): string | null {
    let best: AgentView | null = null;
    let bestY = -Infinity;
    const r = lod === 'dot' ? 8 / scale : 0;
    for (const v of this.views.values()) {
      if (!v.visible || v.fadeOutAt) continue;
      const p = this.positionAt(v, now, this.tmp);
      const hit =
        lod === 'dot'
          ? Math.hypot(wx - p.x, wy - (p.y - 8)) <= r
          : wx >= p.x - 10 && wx <= p.x + 10 && wy >= p.y - 28 && wy <= p.y + 2;
      if (hit && p.y > bestY) {
        best = v;
        bestY = p.y;
      }
    }
    return best?.name ?? null;
  }

  head(name: string, now: number, out: Pt): Pt | null {
    const v = this.views.get(name);
    if (!v) return null;
    this.positionAt(v, now, out);
    out.y -= 30;
    return out;
  }

  hit(name: string, now: number) {
    const v = this.views.get(name);
    if (v) v.hitUntil = now + 180;
  }

  private remove(v: AgentView) {
    v.sprite.destroy();
    v.shadow.destroy();
    v.dot.destroy();
    this.views.delete(v.name);
  }
}
