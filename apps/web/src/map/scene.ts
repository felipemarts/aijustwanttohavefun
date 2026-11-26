/**
 * The live map: a PixiJS scene that reads the store every frame. Baked ground, construction sites, monsters, NPCs,
 * agents, effects, day/night grade and night lights in one world render group; labels and bubbles in screen space.
 */
import type { DayPhase, RoomInfo, SpectatorEvent } from '@ajwf/shared';
import { Application, BitmapFont, Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Changes } from '../data/reducers';
import { dayFractionAt, dramaSnapshot } from '../data/reducers';
import type { DataSource } from '../data/source';
import type { StaticWorld } from '../data/staticWorld';
import type { LiveStore } from '../data/store';
import { i18n } from '../i18n/store';
import { hash32 } from '../util/rng';
import { AgentLayer } from './agents';
import { type Baked, bakeMap } from './art/bake';
import { VOID } from './art/palette';
import * as A from './art/props';
import { SpriteAtlas } from './atlas';
import { Camera } from './camera';
import { controller } from './controller';
import { gradeAt, phaseMid } from './daylight';
import { captionFor, type DirectorMemory, directorStep, initialDirector } from './director';
import { Effects } from './effects';
import { monsterSpot, npcSpot, roomPx, TILE, worldBounds } from './geometry';
import { attachInput } from './input';
import { type Lod, lodFor, nearestStep, pickLabels, type LabelCandidate } from './lod';
import { Overlay, UI_FONT } from './overlay';
import { buildSceneTextures, canvasTexture, type MonsterTex, type SceneTextures } from './textures';

export type SceneOptions = {
  source: DataSource;
  store: LiveStore;
  world: StaticWorld;
  phase: DayPhase | null;
  reducedMotion: boolean;
  /** Initial zoom override (CSS scale). */
  zoom?: number;
};

const LABEL_FONT = 'ajwf-label';
let fontInstalled = false;
const START_ROOM = 'village.square';
const MON_CAP = 3;

type MonsterView = {
  room: string;
  kind: string;
  sprite: Sprite;
  x: number;
  y: number;
  tex: MonsterTex;
  hiddenUntil: number;
  night: boolean;
  offset: number;
  alive: boolean;
  respawnMs: number;
};
type NpcView = {
  id: string;
  sprite: Sprite;
  x: number;
  y: number;
  textures: Texture[] | null;
  offset: number;
};
type SiteView = { room: string; key: string; box: Container; sprite: Sprite | null; bar: Graphics };
type LightView = {
  sprite: Sprite;
  pane: Sprite | null;
  base: number;
  kind: A.LightKind;
  x: number;
  y: number;
  seed: number;
};
type MoteView = { sprite: Sprite; x: number; y: number; kind: 'firefly' | 'wisp'; seed: number };

const LIGHT_TINT: Record<A.LightKind, number> = {
  window: 0xffc070,
  torch: 0xff9a40,
  forge: 0xff7a30,
  lamp: 0xffd27a,
  crystal: 0x6fe3e8,
  cauldron: 0x8af05a,
  rune: 0x5fc9b5,
  candle: 0xffd27a,
  fire: 0xff8a3c,
};

export class MapScene {
  readonly app = new Application();
  readonly camera: Camera;
  private world = new Container({ isRenderGroup: true });
  private ground = new Container();
  private sitesLayer = new Container();
  private shadows = new Container();
  private entities = new Container();
  private fxLayer = new Container();
  private grade = new Sprite(Texture.WHITE);
  private panes = new Container();
  private glows = new Container();
  private dots = new Container();
  private marks = new Container();
  private fxText = new Container();
  private overlay = new Overlay(LABEL_FONT);
  private tex!: SceneTextures;
  private atlas = new SpriteAtlas();
  private agents!: AgentLayer;
  private effects!: Effects;
  private baked: Baked | null = null;
  private bakedKey = '';
  private monsters: MonsterView[] = [];
  private npcs: NpcView[] = [];
  private sites = new Map<string, SiteView>();
  private lights: LightView[] = [];
  private motes: MoteView[] = [];
  private roomOutline = new Graphics();
  private arrow!: Sprite;
  private director: DirectorMemory = initialDirector();
  private lastDirectorAt = 0;
  private lastCaptionAt = 0;
  private lastTopicsAt = 0;
  private lastStatsAt = 0;
  private lastGlintAt = 0;
  private lastSecond = 0;
  private frames = 0;
  private frameMsAcc = 0;
  private updateMsAcc = 0;
  private lod: Lod = 'full';
  private glowLevel = 0;
  private labelCache = new Map<string, string>();
  private labelLang = '';
  private disposers: (() => void)[] = [];
  private destroyed = false;
  private ready = false;
  private pendingArrivals = new Set<string>();
  private tmp = { x: 0, y: 0 };

  private constructor(
    private readonly host: HTMLElement,
    private readonly opts: SceneOptions,
  ) {
    this.camera = new Camera(window.devicePixelRatio || 1);
  }

  static async create(host: HTMLElement, opts: SceneOptions): Promise<MapScene> {
    const scene = new MapScene(host, opts);
    await scene.init();
    return scene;
  }

  private async init() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    await this.app.init({
      resizeTo: this.host,
      background: VOID,
      antialias: false,
      autoDensity: true,
      resolution: dpr,
      roundPixels: true,
      preference: 'webgl',
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
      gcMaxUnusedTime: 10 * 60_000,
    });
    if (this.destroyed) return;
    const canvas = this.app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    this.host.appendChild(canvas);
    this.app.stage.eventMode = 'none';

    if (!fontInstalled)
      BitmapFont.install({
        name: LABEL_FONT,
        style: {
          fontFamily: UI_FONT,
          fontSize: 12,
          fill: 0xffffff,
          fontWeight: '600',
          stroke: { color: 0x241a2e, width: 3, join: 'round' },
        },
        resolution: dpr,
        chars: [['a', 'z'], ['A', 'Z'], ['0', '9'], ' .·-_:!?#%+/()'],
      });
    fontInstalled = true;

    this.tex = buildSceneTextures();
    this.entities.sortableChildren = true;
    this.grade.blendMode = 'multiply';
    this.glows.blendMode = 'add';
    this.world.addChild(
      this.ground,
      this.sitesLayer,
      this.shadows,
      this.entities,
      this.fxLayer,
      this.grade,
      this.panes,
      this.glows,
      this.dots,
      this.marks,
    );
    this.app.stage.addChild(this.world, this.fxText, this.overlay.root);
    this.arrow = new Sprite(this.tex.fx.arrow);
    this.arrow.anchor.set(0.5, 1);
    this.arrow.visible = false;
    this.marks.addChild(this.roomOutline, this.arrow);

    this.agents = new AgentLayer(
      this.entities,
      this.shadows,
      this.dots,
      this.tex,
      this.atlas,
      (h) => this.opts.source.spriteImage(h),
      this.opts.reducedMotion,
    );
    this.effects = new Effects(this.fxLayer, this.fxText, this.tex, this.opts.reducedMotion, LABEL_FONT);

    this.camera.setView(this.app.screen.width, this.app.screen.height);
    this.app.renderer.on('resize', (w: number, h: number) => this.camera.setView(w, h));
    const ro = new ResizeObserver(() => this.app.queueResize());
    ro.observe(this.host);
    this.disposers.push(() => ro.disconnect());

    // Bake after the first paint so the shell shows immediately.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (this.destroyed) return;
    this.rebuildWorld();
    this.placeInitialCamera();

    this.disposers.push(
      attachInput(canvas, this.camera, {
        manual: (kind) => {
          controller.pauseDirector();
          if (kind === 'pan' && controller.follow) controller.setFollow(null);
        },
        tap: (sx, sy) => this.onTap(sx, sy),
      }),
    );
    this.disposers.push(this.opts.store.onChanges((ch) => this.onChanges(ch)));
    this.disposers.push(controller.subscribe('panel', () => this.onPanel()));
    controller.commands = {
      zoom: (dir) => {
        controller.pauseDirector();
        this.camera.stepZoom(dir);
      },
      focusRoom: (id) => this.focusRoom(id),
      focusAgent: (name) => this.focusAgent(name),
    };
    const onVis = () => (document.visibilityState === 'hidden' ? this.app.stop() : this.app.start());
    document.addEventListener('visibilitychange', onVis);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVis));

    this.syncAgents();
    this.ready = true;
    this.app.ticker.add(() => this.frame());
  }

  destroy() {
    this.destroyed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    if (controller.commands) controller.commands = null;
    try {
      this.app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    } catch {
      // init never finished
    }
  }

  // ── World building ──────────────────────────────────────────────────────────

  private rooms(): RoomInfo[] {
    const live = this.opts.store.state.rooms;
    return live.size ? [...live.values()] : this.opts.world.rooms;
  }

  private rebuildWorld() {
    const rooms = this.rooms();
    const key = rooms.map((r) => `${r.id}:${r.rect.join(',')}`).join('|');
    if (key === this.bakedKey) return;
    this.bakedKey = key;
    for (const c of this.ground.removeChildren()) c.destroy({ texture: true, textureSource: true });
    const baked = bakeMap(rooms, this.opts.world);
    this.baked = baked;
    for (const ch of baked.chunks) {
      const s = new Sprite(canvasTexture(ch.canvas));
      s.position.set(ch.x, ch.y);
      s.cullable = true;
      this.ground.addChild(s);
    }
    this.camera.bounds = worldBounds(rooms, 3);
    this.grade.position.set(baked.x, baked.y);
    this.grade.width = baked.w;
    this.grade.height = baked.h;
    this.buildLights(baked);
    this.buildMonstersAndNpcs(rooms);
    this.syncSites();
  }

  private buildLights(baked: Baked) {
    for (const c of this.glows.removeChildren()) c.destroy();
    for (const c of this.panes.removeChildren()) c.destroy();
    this.lights = [];
    this.motes = [];
    for (const l of baked.lights) {
      const big = l.kind === 'forge' || l.kind === 'fire' || l.kind === 'rune';
      const small =
        l.kind === 'window' || l.kind === 'candle' || l.kind === 'cauldron' || l.kind === 'crystal';
      const s = new Sprite(this.tex.fx[big ? 'glowL' : small ? 'glowS' : 'glowM']);
      s.anchor.set(0.5);
      s.position.set(l.x, l.y);
      s.tint = LIGHT_TINT[l.kind];
      s.alpha = 0;
      this.glows.addChild(s);
      let pane: Sprite | null = null;
      if (l.kind === 'window' && l.w && l.h) {
        pane = new Sprite(this.tex.fx.white);
        pane.anchor.set(0.5);
        pane.position.set(l.x, l.y);
        pane.width = l.w;
        pane.height = l.h;
        pane.tint = 0xf8d27a;
        pane.alpha = 0;
        this.panes.addChild(pane);
      }
      this.lights.push({
        sprite: s,
        pane,
        base: l.kind === 'crystal' || l.kind === 'rune' ? 0.7 : 1,
        kind: l.kind,
        x: l.x,
        y: l.y,
        seed: hash32(`${l.x},${l.y}`) % 1000,
      });
    }
    for (const a of baked.ambient) {
      const s = new Sprite(this.tex.fx.mote);
      s.anchor.set(0.5);
      s.tint = a.kind === 'firefly' ? 0xe8f070 : 0x9ff6ff;
      s.alpha = 0;
      this.glows.addChild(s);
      this.motes.push({ sprite: s, x: a.x, y: a.y, kind: a.kind, seed: hash32(`${a.x},${a.y}`) % 1000 });
    }
  }

  private buildMonstersAndNpcs(rooms: RoomInfo[]) {
    for (const m of this.monsters) m.sprite.destroy();
    for (const n of this.npcs) n.sprite.destroy();
    this.monsters = [];
    this.npcs = [];
    const byId = new Map(this.opts.world.rooms.map((r) => [r.id, r]));
    for (const room of rooms) {
      const st = byId.get(room.id);
      if (!st) continue;
      let total = 0;
      for (const mon of st.monsters) {
        const info = this.opts.world.monsters[mon.id];
        const cap = info?.boss ? 1 : MON_CAP;
        for (let i = 0; i < Math.min(mon.n, cap) && total < 6; i++, total++) {
          const tex = this.tex.monster(mon.id);
          const p = info?.boss
            ? { x: roomPx(room).x + roomPx(room).w / 2, y: roomPx(room).y + roomPx(room).h * 0.62 }
            : monsterSpot(room, mon.id, i);
          const s = new Sprite(tex.frames[0]);
          s.anchor.set(tex.ax / tex.w, tex.ay / tex.h);
          s.position.set(p.x, p.y);
          s.zIndex = p.y;
          this.entities.addChild(s);
          this.monsters.push({
            room: room.id,
            kind: mon.id,
            sprite: s,
            x: p.x,
            y: p.y,
            tex,
            hiddenUntil: 0,
            night: !!mon.night,
            offset: hash32(`${room.id}${mon.id}${i}`) % 900,
            alive: true,
            respawnMs: Math.min(120_000, (info?.respawnSec ?? 90) * 1000),
          });
        }
      }
      st.npcs.forEach((id, i) => {
        const p = npcSpot(room, i);
        const s = new Sprite(this.tex.placeholder[0]);
        s.anchor.set(0.5, 1);
        s.position.set(p.x, p.y);
        s.zIndex = p.y;
        s.alpha = 0;
        this.entities.addChild(s);
        const v: NpcView = { id, sprite: s, x: p.x, y: p.y, textures: null, offset: hash32(id) % 1000 };
        this.npcs.push(v);
        void this.atlas
          .ensure(`n:${id}`, () => this.opts.source.npcSpriteImage(id))
          .then((t) => {
            if (t) {
              v.textures = t;
              s.alpha = 1;
            }
          });
      });
    }
  }

  /** Construction sites: empty lot with a sign, scaffolding with a progress bar, or the finished building. */
  private syncSites() {
    const baked = this.baked;
    if (!baked) return;
    const s = this.opts.store.state;
    const buildingOf = (projectId: string) =>
      this.opts.world.projects.find((p) => p.id === projectId)?.building ?? projectId;
    for (const [roomId, site] of Object.entries(baked.sites)) {
      const proj = s.projects.find((p) => p.plot === roomId);
      const builtProject = s.buildings[roomId] ?? (proj?.done ? proj.id : null);
      const room = s.rooms.get(roomId);
      let state: 'none' | 'lot' | 'work' | 'done' = 'none';
      let building = '';
      if (builtProject) {
        state = 'done';
        building = buildingOf(builtProject);
      } else if (room?.building) {
        state = 'done';
        building = room.building;
      } else if (proj) state = 'work';
      else if (site.plot) state = 'lot';
      const progress = proj?.progress ?? 0;
      const key = `${state}:${building}`;
      let v = this.sites.get(roomId);
      if (!v) {
        const box = new Container();
        const bar = new Graphics();
        box.addChild(bar);
        this.sitesLayer.addChild(box);
        v = { room: roomId, key: '', box, sprite: null, bar };
        this.sites.set(roomId, v);
      }
      if (v.key !== key) {
        v.key = key;
        if (v.sprite) {
          v.sprite.destroy({ texture: true, textureSource: true });
          v.sprite = null;
        }
        let art: A.Art | null = null;
        if (state === 'lot') art = A.emptyLot(Math.min(site.w, 124), 54);
        else if (state === 'work')
          art = A.scaffold(
            Math.min(site.w, roomId === 'village.river_bank' ? 52 : 110),
            Math.min(site.h, 52),
            hash32(roomId),
          );
        else if (state === 'done')
          art =
            building === 'bridge' && baked.bridge
              ? A.bridge(baked.bridge.w + 8, baked.bridge.h + 8)
              : A.projectBuilding(building);
        if (art) {
          const sp = new Sprite(canvasTexture(art.buf.toCanvas()));
          sp.anchor.set(art.ax / art.buf.w, art.ay / art.buf.h);
          sp.position.set(site.x, site.y);
          v.box.addChildAt(sp, 0);
          v.sprite = sp;
        }
      }
      v.bar.clear();
      if (state === 'work') {
        const w = 44;
        const x = Math.round(site.x - w / 2);
        const y = Math.round(site.y - Math.min(site.h, 52) - 10);
        v.bar.rect(x - 1, y - 1, w + 2, 7).fill(0x241a2e);
        v.bar.rect(x, y, w, 5).fill(0x4a3d66);
        v.bar.rect(x, y, Math.round(w * progress), 5).fill(0xf2b84b);
        v.bar.rect(x, y, Math.round(w * progress), 1).fill(0xffe08a);
      }
    }
  }

  private placeInitialCamera() {
    const room = this.rooms().find((r) => r.id === START_ROOM) ?? this.rooms()[0];
    const s = this.opts.zoom ?? this.directorScale();
    if (room) {
      const r = roomPx(room);
      this.camera.moveTo(r.x + r.w / 2, r.y + r.h / 2 + 6, s, 0);
      // The postcard: start on the square with the director already "there".
      this.director = { room: room.id, prev: null, since: performance.now(), peak: 0, lastRiseAt: 0 };
      controller.setDirectorRoom(room.id, {
        key: 'ui.director.caption.welcome',
        params: { room: `@room:${room.id}` },
      });
      this.opts.store.setTopics('director', [`room:${room.id}`]);
    }
  }

  private directorScale(): number {
    const target = this.camera.viewW / (TILE * 12 * 3.2);
    return Math.max(1.5, Math.min(3, nearestStep(this.camera.steps, target)));
  }

  // ── Live data ──────────────────────────────────────────────────────────────

  private syncAgents() {
    const s = this.opts.store.state;
    this.agents.sync(
      s.agents,
      s.rooms.size ? s.rooms : new Map(this.opts.world.rooms.map((r) => [r.id, r])),
      performance.now(),
      this.pendingArrivals,
    );
    this.pendingArrivals.clear();
  }

  private onChanges(ch: Changes) {
    if (!this.ready) return;
    if (ch.rooms) {
      this.rebuildWorld();
      this.syncSites();
    }
    for (const ev of ch.events) if (ev.type === 'arrival' && ev.actor) this.pendingArrivals.add(ev.actor);
    if (ch.agents) this.syncAgents();
    for (const room of ch.extras) this.applyExtras(room);
    const now = performance.now();
    const view = this.camera.viewRect(120);
    for (const ev of ch.events) {
      try {
        this.effectFor(ev, now, view);
      } catch {
        // an odd event never breaks the frame
      }
    }
  }

  private applyExtras(roomId: string) {
    const extras = this.opts.store.state.roomExtras.get(roomId);
    if (!extras) return;
    const count = new Map(extras.monsters.map((m) => [m.id, m.n]));
    const seen = new Map<string, number>();
    for (const m of this.monsters) {
      if (m.room !== roomId) continue;
      const i = seen.get(m.kind) ?? 0;
      seen.set(m.kind, i + 1);
      m.alive = i < (count.get(m.kind) ?? 0);
      if (m.alive) m.hiddenUntil = 0;
    }
  }

  private monsterIn(room: string, kind: string | undefined): MonsterView | undefined {
    if (!kind) return undefined;
    const k = kind.split(/[#:]/)[0]!;
    const now = performance.now();
    return this.monsters.find((m) => m.room === room && m.kind === k && m.alive && m.hiddenUntil < now);
  }

  private effectFor(ev: SpectatorEvent, now: number, view: { x: number; y: number; w: number; h: number }) {
    const room = ev.room;
    if (!room) return;
    const inView = (x: number, y: number) =>
      x > view.x && x < view.x + view.w && y > view.y && y < view.y + view.h;
    const agentPos = (name: string | undefined) => {
      if (!name) return null;
      const v = this.agents.views.get(name);
      if (!v) return null;
      const p = this.agents.positionAt(v, now, { x: 0, y: 0 });
      return inView(p.x, p.y) ? p : null;
    };
    const tr = i18n.tr;
    switch (ev.type) {
      case 'say':
        if (ev.actor && typeof ev.text === 'string' && this.agents.views.has(ev.actor))
          this.overlay.say(ev.actor, ev.text, ev.lang ?? null, now);
        return;
      case 'attack':
      case 'cast_hit': {
        const dmg = typeof ev.p?.dmg === 'number' ? ev.p.dmg : null;
        if (ev.tk === 'agent' && ev.target) {
          const p = agentPos(ev.target);
          if (p) {
            this.effects.hit(p.x, p.y, dmg, now);
            this.agents.hit(ev.target, now);
          }
          return;
        }
        const m = this.monsterIn(
          room,
          ev.target ?? (typeof ev.p?.target === 'string' ? ev.p.target.replace('@mon:', '') : undefined),
        );
        if (m && inView(m.x, m.y)) this.effects.hit(m.x, m.y, dmg, now);
        return;
      }
      case 'kill': {
        const m = this.monsterIn(
          room,
          ev.target ?? (typeof ev.p?.target === 'string' ? ev.p.target.replace('@mon:', '') : undefined),
        );
        if (m) {
          m.hiddenUntil = now + m.respawnMs;
          if (inView(m.x, m.y)) this.effects.poof(m.x, m.y, now);
        }
        return;
      }
      case 'spawn': {
        const k = ev.target?.split(/[#:]/)[0];
        const m = this.monsters.find((x) => x.room === room && x.kind === k && x.hiddenUntil > now);
        if (m) {
          m.hiddenUntil = 0;
          if (inView(m.x, m.y)) this.effects.poof(m.x, m.y, now);
        }
        return;
      }
      case 'level_up': {
        const p = agentPos(ev.actor);
        const level = ev.p?.level ?? '';
        if (p) this.effects.levelUp(p.x, p.y, level, tr.t('ui.map.level_up', { level }), now);
        return;
      }
      case 'achievement':
      case 'world_first': {
        const p = agentPos(ev.actor);
        if (p) this.effects.star(p.x, p.y, now);
        return;
      }
      case 'fallen': {
        const p = agentPos(ev.actor);
        if (p) this.effects.wisp(p.x, p.y, now);
        return;
      }
      case 'rare_drop': {
        const p = agentPos(ev.actor);
        if (p) this.effects.glint(p.x, p.y, now);
        return;
      }
      case 'heal':
      case 'revive': {
        const p = agentPos(ev.tk === 'agent' && ev.target ? ev.target : ev.actor);
        if (p) this.effects.heal(p.x, p.y, now);
        return;
      }
      default:
        return;
    }
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  private onTap(sx: number, sy: number) {
    controller.pauseDirector();
    const w = this.camera.toWorld(sx, sy);
    const now = performance.now();
    const agent = this.agents.hitTest(w.x, w.y, this.lod, this.camera.scale, now);
    if (agent) {
      controller.openAgent(agent);
      return;
    }
    for (const room of this.rooms()) {
      const r = roomPx(room);
      if (w.x >= r.x - TILE && w.x < r.x + r.w + TILE && w.y >= r.y - TILE && w.y < r.y + r.h + TILE) {
        controller.openRoom(room.id);
        return;
      }
    }
    controller.closePanel();
  }

  private onPanel() {
    const p = controller.panel;
    this.opts.store.setTopics('panel', p ? [p.kind === 'room' ? `room:${p.id}` : `agent:${p.name}`] : []);
    this.roomOutline.clear();
    if (p?.kind === 'room') {
      const room = this.rooms().find((r) => r.id === p.id);
      if (room) {
        const r = roomPx(room);
        const g = this.roomOutline;
        const c = 0xf2b84b;
        // stepped corners
        g.rect(r.x + 2, r.y - 1, r.w - 4, 2).fill(c);
        g.rect(r.x + 2, r.y + r.h - 1, r.w - 4, 2).fill(c);
        g.rect(r.x - 1, r.y + 2, 2, r.h - 4).fill(c);
        g.rect(r.x + r.w - 1, r.y + 2, 2, r.h - 4).fill(c);
        g.rect(r.x, r.y, 2, 2).fill(c);
        g.rect(r.x + r.w - 2, r.y, 2, 2).fill(c);
        g.rect(r.x, r.y + r.h - 2, 2, 2).fill(c);
        g.rect(r.x + r.w - 2, r.y + r.h - 2, 2, 2).fill(c);
      }
    }
  }

  focusRoom(id: string) {
    const room = this.rooms().find((r) => r.id === id);
    if (!room) return;
    controller.pauseDirector();
    const r = roomPx(room);
    this.camera.moveTo(
      r.x + r.w / 2,
      r.y + r.h / 2,
      Math.max(this.camera.scale, 1.5),
      this.opts.reducedMotion ? 0 : 900,
    );
  }

  focusAgent(name: string) {
    const p = this.agents.head(name, performance.now(), { x: 0, y: 0 });
    if (!p) return;
    this.camera.moveTo(p.x, p.y + 20, Math.max(this.camera.scale, 2), this.opts.reducedMotion ? 0 : 900);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  private frame() {
    const t0 = performance.now();
    const now = t0;
    const dt = this.app.ticker.deltaMS;
    const cam = this.camera;
    const store = this.opts.store;

    // Follow keeps the camera on the agent.
    if (controller.follow) {
      const p = this.agents.head(controller.follow, now, this.tmp);
      if (p) {
        const k = Math.min(1, (dt / 1000) * 4);
        cam.x += (p.x - cam.x) * k;
        cam.y += (p.y + 24 - cam.y) * k;
        cam.clamp();
      }
    }
    cam.update(now, dt);
    const s = cam.scale;
    const res = this.app.renderer.resolution;
    this.world.scale.set(s);
    this.world.position.set(
      Math.round((cam.viewW / 2 - cam.x * s) * res) / res,
      Math.round((cam.viewH / 2 - cam.y * s) * res) / res,
    );
    this.lod = lodFor(s);
    const view = cam.viewRect(40);

    // Ground chunks: cull by hand (cheap, six sprites).
    for (const c of this.ground.children) {
      const sp = c as Sprite;
      sp.visible =
        sp.x < view.x + view.w &&
        sp.x + sp.width > view.x &&
        sp.y < view.y + view.h &&
        sp.y + sp.height > view.y;
    }

    // Day and night.
    const t = this.opts.phase ? phaseMid(this.opts.phase) : dayFractionAt(store.state, now);
    const g = gradeAt(t);
    this.grade.tint = g.grade;
    this.glowLevel = g.glow;

    const visible = this.agents.update(now, view, this.lod, s);
    this.updateMonsters(now, view);
    this.updateLights(now, view);
    this.effects.update(now);
    this.atlas.flush();

    // Screen-space texts (damage numbers, level labels) follow their world anchors.
    this.fxText.visible = this.lod !== 'dot';
    this.effects.forEachText((txt, x, y, rise) => {
      const p = cam.toScreen(x, y);
      txt.position.set(Math.round(p.x), Math.round(p.y - rise * Math.max(1, s / 2)));
    });

    this.updateLabels(now, view);
    this.overlay.layoutBubbles(
      now,
      (agent) => {
        const v = this.agents.views.get(agent);
        if (!v || !v.visible) return null;
        const p = this.agents.positionAt(v, now, this.tmp);
        const sp = cam.toScreen(p.x, p.y - 30);
        // above the name label when labels are on
        return { x: sp.x, y: sp.y - (this.lod === 'full' ? 26 : 2) };
      },
      this.lod !== 'dot',
    );

    // Selected agent arrow.
    const panel = controller.panel;
    if (panel?.kind === 'agent' && this.lod !== 'dot') {
      const p = this.agents.head(panel.name, now, this.tmp);
      this.arrow.visible = !!p;
      if (p)
        this.arrow.position.set(
          Math.round(p.x),
          Math.round(p.y - 2 - (this.opts.reducedMotion ? 0 : Math.abs(Math.sin(now / 250)) * 3)),
        );
    } else this.arrow.visible = false;

    if (now - this.lastGlintAt > 350 && this.baked?.glints.length) {
      this.lastGlintAt = now;
      const gl = this.baked.glints[Math.floor(Math.random() * this.baked.glints.length)]!;
      if (gl.x > view.x && gl.x < view.x + view.w && gl.y > view.y && gl.y < view.y + view.h)
        this.effects.twinkle(gl.x, gl.y, gl.color, now);
    }

    if (now - this.lastDirectorAt > 1000) {
      this.lastDirectorAt = now;
      this.directorTick(now);
    }
    if (now - this.lastTopicsAt > 1200) {
      this.lastTopicsAt = now;
      this.updateViewportTopics(view);
    }
    if (now - this.lastSecond > 1000) {
      this.lastSecond = now;
      store.tick();
    }

    // Stats for the debug readout.
    this.frames++;
    this.frameMsAcc += this.app.ticker.elapsedMS;
    this.updateMsAcc += performance.now() - t0;
    if (now - this.lastStatsAt > 500) {
      const n = Math.max(1, this.frames);
      controller.setStats({
        fps: Math.round((1000 * n) / Math.max(1, this.frameMsAcc)),
        frameMs: Math.round((this.frameMsAcc / n) * 10) / 10,
        updateMs: Math.round((this.updateMsAcc / n) * 100) / 100,
        agents: this.agents.views.size,
        visible,
        labels: this.overlay.labelCount,
        lod: this.lod,
        scale: Math.round(s * 100) / 100,
        atlasPages: this.atlas.pageCount,
        renderer: this.app.renderer.name,
      });
      this.frames = 0;
      this.frameMsAcc = 0;
      this.updateMsAcc = 0;
      this.lastStatsAt = now;
    }
  }

  private updateMonsters(now: number, view: { x: number; y: number; w: number; h: number }) {
    const night = this.glowLevel > 0.5;
    const flip = Math.floor(now / 450);
    for (const m of this.monsters) {
      const show =
        m.alive &&
        m.hiddenUntil < now &&
        (!m.night || night) &&
        m.x > view.x &&
        m.x < view.x + view.w &&
        m.y > view.y &&
        m.y < view.y + view.h + 40;
      m.sprite.visible = show && this.lod !== 'dot';
      if (!m.sprite.visible) continue;
      const f = (flip + (m.offset > 450 ? 1 : 0)) % 2;
      m.sprite.texture = m.tex.frames[f]!;
      if (m.kind === 'will_o_wisp' || m.kind === 'wraith')
        m.sprite.y = m.y - 3 - (this.opts.reducedMotion ? 0 : Math.round(Math.sin(now / 400 + m.offset) * 2));
    }
    for (const n of this.npcs) {
      const show =
        n.x > view.x &&
        n.x < view.x + view.w &&
        n.y > view.y &&
        n.y < view.y + view.h + 30 &&
        this.lod !== 'dot';
      n.sprite.visible = show;
      if (!show) continue;
      const tx = n.textures ?? this.tex.placeholder;
      const tt = now / 1000 + n.offset;
      n.sprite.texture = tt % 4 < 0.15 ? tx[3]! : tx[0]!;
    }
  }

  private updateLights(now: number, view: { x: number; y: number; w: number; h: number }) {
    const glow = this.glowLevel;
    const on = glow > 0.02;
    this.glows.visible = on;
    this.panes.visible = on;
    if (!on) return;
    for (const l of this.lights) {
      const vis =
        l.x > view.x - 40 && l.x < view.x + view.w + 40 && l.y > view.y - 40 && l.y < view.y + view.h + 40;
      l.sprite.visible = vis;
      if (l.pane) l.pane.visible = vis;
      if (!vis) continue;
      const flicker =
        l.kind === 'torch' || l.kind === 'fire' || l.kind === 'forge'
          ? 0.85 + 0.15 * Math.sin(now / 90 + l.seed) * Math.sin(now / 157 + l.seed * 3)
          : 1;
      // crystals and runes glow a little even by day
      const level =
        l.kind === 'crystal' || l.kind === 'rune' || l.kind === 'forge' ? Math.max(glow, 0.3) : glow;
      l.sprite.alpha = level * l.base * flicker;
      if (l.pane) l.pane.alpha = Math.min(1, glow * 1.2);
    }
    for (const m of this.motes) {
      const t = now / 1000 + m.seed;
      const dx = this.opts.reducedMotion ? 0 : Math.sin(t * 0.7) * 10 + Math.sin(t * 1.9) * 3;
      const dy = this.opts.reducedMotion ? 0 : Math.cos(t * 0.5) * 6;
      const x = m.x + dx;
      const y = m.y + dy;
      const vis = x > view.x && x < view.x + view.w && y > view.y && y < view.y + view.h;
      m.sprite.visible = vis;
      if (!vis) continue;
      m.sprite.position.set(Math.round(x), Math.round(y));
      m.sprite.alpha = glow * (0.5 + 0.5 * Math.sin(t * 3));
    }
  }

  private updateLabels(now: number, view: { x: number; y: number; w: number; h: number }) {
    this.overlay.beginLabels();
    if (this.lod === 'full') {
      const tr = i18n.tr;
      if (tr.lang !== this.labelLang || this.labelCache.size > 3000) {
        this.labelCache.clear();
        this.labelLang = tr.lang;
      }
      const cands: LabelCandidate[] = [];
      const panel = controller.panel;
      for (const v of this.agents.views.values()) {
        if (!v.visible || v.fadeOutAt) continue;
        const p = this.agents.positionAt(v, now, this.tmp);
        if (p.x < view.x + 30 || p.x > view.x + view.w - 30) continue;
        let priority = 0;
        if (controller.follow === v.name || (panel?.kind === 'agent' && panel.name === v.name)) priority = 3;
        else if (this.overlay.hasBubble(v.name)) priority = 2;
        else if (v.pos.f?.includes('f')) priority = 1;
        cands.push({ name: v.name, x: p.x, y: p.y, priority });
      }
      const picked = pickLabels(cands, this.camera.x, this.camera.y);
      // Greedy placement, most important first: a label that would overlap one already placed is skipped.
      cands.sort((a, b) => b.priority - a.priority || a.y - b.y);
      const placed: { x: number; y: number }[] = [];
      for (const c of cands) {
        if (!picked.has(c.name)) continue;
        const at = this.camera.toScreen(c.x, c.y - 30);
        if (c.priority < 3 && placed.some((q) => Math.abs(q.x - at.x) < 70 && Math.abs(q.y - at.y) < 24))
          continue;
        placed.push({ x: at.x, y: at.y });
        const v = this.agents.views.get(c.name)!;
        const key = `${v.name}|${v.pos.l}`;
        let line = this.labelCache.get(key);
        if (line === undefined) {
          line = tr.t('ui.map.name_level', { name: v.name, level: v.pos.l });
          this.labelCache.set(key, line);
        }
        const title = v.pos.t ? tr.name('title', v.pos.t) : '';
        this.overlay.label(v.name, line, title, at.x, at.y, c.priority === 3);
      }
    }
    this.overlay.endLabels();
  }

  private directorTick(now: number) {
    const store = this.opts.store;
    const d = controller.director;
    if (!d.enabled || controller.follow) {
      return;
    }
    const drama = dramaSnapshot(store.state, now);
    const population: Record<string, number> = {};
    for (const a of store.state.agents.values()) population[a.r] = (population[a.r] ?? 0) + 1;
    const { mem, cut } = directorStep(this.director, drama, now, population);
    this.director = mem;
    const rooms = this.rooms();
    const bosses = new Set(
      Object.values(this.opts.world.monsters)
        .filter((m) => m.boss)
        .map((m) => m.id),
    );
    const zones = this.opts.world.zones;
    const capOf = (roomId: string) => {
      const room = rooms.find((r) => r.id === roomId);
      const lawless = !!room && (zones[room.zone]?.law === 'lawless' || room.flags.includes('lawless'));
      const log = store.state.roomLogs.get(roomId) ?? [];
      const nowTs = now + store.state.clockSkew;
      return captionFor(roomId, log, nowTs, { lawless, bosses });
    };
    if (cut) {
      const room = rooms.find((r) => r.id === cut);
      if (room) {
        const r = roomPx(room);
        this.camera.moveTo(
          r.x + r.w / 2,
          r.y + r.h / 2 + 6,
          this.directorScale(),
          this.opts.reducedMotion ? 0 : 1300,
        );
        store.setTopics('director', [`room:${cut}`]);
        controller.setDirectorRoom(cut, capOf(cut));
        this.lastCaptionAt = now;
      }
      return;
    }
    if (mem.room && now - this.lastCaptionAt > 2500) {
      this.lastCaptionAt = now;
      const cap = capOf(mem.room);
      // Keep the welcome caption until something actually happens on the square.
      if (
        cap.key !== 'ui.director.caption.room' ||
        controller.director.caption?.key !== 'ui.director.caption.welcome'
      )
        controller.setCaption(cap);
    }
  }

  private updateViewportTopics(view: { x: number; y: number; w: number; h: number }) {
    if (this.lod === 'dot') {
      this.opts.store.setTopics('viewport', []);
      return;
    }
    const cx = this.camera.x;
    const cy = this.camera.y;
    const inView = this.rooms()
      .map((room) => ({ room, r: roomPx(room) }))
      .filter(
        ({ r }) => r.x < view.x + view.w && r.x + r.w > view.x && r.y < view.y + view.h && r.y + r.h > view.y,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.r.x + a.r.w / 2 - cx, a.r.y + a.r.h / 2 - cy) -
          Math.hypot(b.r.x + b.r.w / 2 - cx, b.r.y + b.r.h / 2 - cy),
      )
      .slice(0, 10)
      .map(({ room }) => `room:${room.id}`);
    this.opts.store.setTopics('viewport', inView);
  }
}
