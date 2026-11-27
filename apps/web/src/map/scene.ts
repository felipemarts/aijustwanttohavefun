/**
 * The live map: a PixiJS scene that reads the store every frame. Baked ground, construction sites, monsters, NPCs,
 * agents, effects, day/night grade and night lights in one world render group; labels and bubbles in screen space.
 */
import type { DayPhase, RoomInfo, SpectatorEvent } from '@ajwf/shared';
// The production CSP has no 'unsafe-eval': Pixi's shader and uniform code must not use `new Function`.
import 'pixi.js/unsafe-eval';
import { Application, BitmapFont, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { config } from '../config';
import { drawMockSheet } from '../data/mockSprites';
import type { Changes } from '../data/reducers';
import { dayFractionAt, dramaSnapshot } from '../data/reducers';
import { bigAhead, interestAt, type Reason, reasonFor } from '../data/scout';
import type { DataSource } from '../data/source';
import type { StaticWorld } from '../data/staticWorld';
import type { LiveStore } from '../data/store';
import { i18n } from '../i18n/store';
import { type Activity, bigMoment, starNow } from '../view/activity';
import { hash32 } from '../util/rng';
import { AgentLayer } from './agents';
import { type Baked, bakeMap } from './art/bake';
import { VOID } from './art/palette';
import * as A from './art/props';
import { SpriteAtlas } from './atlas';
import { Camera } from './camera';
import { controller } from './controller';
import { gradeAt, phaseMid } from './daylight';
import {
  type Cut,
  DIRECTOR,
  type DirectorMemory,
  type DirectorWorld,
  directorStep,
  initialDirector,
  resumedDirector,
  starCaption,
  startMoment,
} from './director';
import { Effects } from './effects';
import { monsterSpot, npcSpot, roomPx, TILE, worldBounds } from './geometry';
import { attachInput } from './input';
import { type Lod, lodFor, nearestStep, pickLabels, type LabelCandidate } from './lod';
import { Overlay, UI_FONT } from './overlay';
import { siteKey, siteState } from './sites';
import { buildSceneTextures, canvasTexture, type MonsterTex, type SceneTextures } from './textures';
import { directorVoice } from './voice';

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
/** Id of the scene in charge of the shared state (store delay, topics, map commands); see `destroy`. */
let activeScene = 0;
let sceneSeq = 0;
let fontInstalled = false;
const START_ROOM = 'village.square';
const MON_CAP = 3;
/** Rooms the director's scout subscribes to ahead of time, beyond the room on screen. */
const SCOUT_ROOMS = 4;

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
type SiteView = {
  room: string;
  key: string;
  box: Container;
  sprite: Sprite | null;
  /** Scaffolding drawn over a room's own look while its project is under way. */
  overlay: Sprite | null;
  statue: Sprite | null;
  /** Sprite hash of the honoree the statue was cast from; null for the cloaked placeholder. */
  statueOf: string | null;
  bar: Graphics;
  lights: LightView[];
  /** When the building appeared (grow-in animation), 0 when settled. */
  appearAt: number;
  /** Ground point and size of the picture, for the celebration. */
  cx: number;
  cy: number;
  w: number;
  h: number;
};
/** A ribbon banner over the map. `follow`: anchored above that agent (the director's star) instead of a fixed point. */
type Banner = { box: Container; x: number; y: number; t0: number; dur: number; follow?: string };
type BannerTone = 'gold' | 'danger' | 'teal';
/** Band, light top edge, dark bottom edge and tails of a banner, by tone. */
const BANNER_COLORS: Record<BannerTone, [number, number, number, number]> = {
  gold: [0xf2b84b, 0xffe08a, 0xd99a2b, 0xb9842a],
  danger: [0xe0605a, 0xf29a8a, 0xb0403c, 0x8c3030],
  teal: [0x5fc9b5, 0x9fe8d8, 0x3f9a8a, 0x2f7a6c],
};
const BANNER_TONE: Record<string, BannerTone> = {
  revive: 'teal',
  world_first: 'gold',
  jackpot: 'gold',
  boss_kill: 'gold',
  rare_drop: 'gold',
  duel: 'gold',
  generic: 'gold',
};
/** Colours of the star's spotlight and of the link to the other party, by tone of what they are doing. */
const TONE_COLOR: Record<string, number> = { danger: 0xe0605a, teal: 0x5fc9b5, gold: 0xf2b84b, plain: 0xf0a050 };
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
  private readonly id = ++sceneSeq;
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
  private banners: Banner[] = [];
  private bannerLayer = new Container();
  private lights: LightView[] = [];
  private motes: MoteView[] = [];
  private roomOutline = new Graphics();
  /** The director's star: a soft ring under them, and a link to whoever their current action involves. */
  private spot = new Graphics();
  private link = new Graphics();
  /** Spectator events about the star (as shown, so delayed in director mode), newest last. */
  private starEvents: SpectatorEvent[] = [];
  private starOf = '';
  private starWhy: Reason | null = null;
  private starActivity: Activity | null = null;
  private starBanner: { banner: Banner; points: number } | null = null;
  private pendingBanner: { key: string; params: Record<string, string | number>; points: number; at: number } | null = null;
  /** Until when the camera pushes in on the star (a big moment). */
  private pushUntil = 0;
  private bosses = new Set<string>();
  private arrow!: Sprite;
  private director: DirectorMemory = initialDirector();
  private directorOn = controller.director.enabled;
  private lastDirectorAt = 0;
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
    // The newest scene is in charge, even while an older one is still finishing its start.
    activeScene = this.id;
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
    this.app.stage.addChild(this.world, this.fxText, this.overlay.root, this.bannerLayer);
    this.arrow = new Sprite(this.tex.fx.arrow);
    this.arrow.anchor.set(0.5, 1);
    this.arrow.visible = false;
    this.marks.addChild(this.roomOutline, this.arrow, this.link);
    this.shadows.addChild(this.spot);
    this.bosses = new Set(
      Object.values(this.opts.world.monsters)
        .filter((m) => m.boss)
        .map((m) => m.id),
    );

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
          controller.pendingFocus = null;
          controller.pauseDirector();
          if (kind === 'pan' && controller.follow) controller.setFollow(null);
        },
        tap: (sx, sy) => this.onTap(sx, sy),
      }),
    );
    this.disposers.push(this.opts.store.onChanges((ch) => this.onChanges(ch)));
    this.disposers.push(controller.subscribe('panel', () => this.onPanel()));
    this.disposers.push(controller.subscribe('director', () => this.onDirector()));
    // Director mode plays the world with a broadcast delay; manual browsing is live.
    if (activeScene === this.id) this.opts.store.setDelay(this.directorOn);
    if (activeScene === this.id)
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
    if (controller.pendingFocus) {
      // kept until the viewer moves the map: a remounted scene (StrictMode, back navigation) shows it again
      const id = controller.pendingFocus;
      controller.pauseDirector();
      const room = this.rooms().find((r) => r.id === id);
      if (room) {
        const r = roomPx(room);
        this.camera.moveTo(r.x + r.w / 2, r.y + r.h / 2, Math.max(this.camera.scale, 1.5), 0);
      }
    }
    this.ready = true;
    this.app.ticker.add(() => this.frame());
  }

  destroy() {
    this.destroyed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    // A remount (StrictMode, back navigation) may destroy the old scene after the new one started: only the scene in
    // charge hands back the shared state (the broadcast delay, the scout's topics, the map commands).
    if (activeScene === this.id) {
      activeScene = 0;
      this.opts.store.setDelay(false);
      this.opts.store.setTopics('scout', []);
      controller.setStarView({ star: null, now: null, recent: [], why: null });
      controller.commands = null;
      directorVoice.stop();
    }
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
    for (const v of this.sites.values()) v.box.destroy({ children: true });
    this.sites.clear();
    this.syncSites([]);
  }

  private buildLights(baked: Baked) {
    for (const c of this.glows.removeChildren()) c.destroy();
    for (const c of this.panes.removeChildren()) c.destroy();
    this.lights = [];
    this.motes = [];
    for (const l of baked.lights) this.lights.push(this.makeLight(l));
    for (const a of baked.ambient) {
      const s = new Sprite(this.tex.fx.mote);
      s.anchor.set(0.5);
      s.tint = a.kind === 'firefly' ? 0xe8f070 : 0x9ff6ff;
      s.alpha = 0;
      this.glows.addChild(s);
      this.motes.push({ sprite: s, x: a.x, y: a.y, kind: a.kind, seed: hash32(`${a.x},${a.y}`) % 1000 });
    }
  }

  private makeLight(l: A.Light): LightView {
    const big = l.kind === 'forge' || l.kind === 'fire' || l.kind === 'rune';
    const small = l.kind === 'window' || l.kind === 'candle' || l.kind === 'cauldron' || l.kind === 'crystal';
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
    return {
      sprite: s,
      pane,
      base: l.kind === 'crystal' || l.kind === 'rune' ? 0.7 : 1,
      kind: l.kind,
      x: l.x,
      y: l.y,
      seed: hash32(`${l.x},${l.y}`) % 1000,
    };
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

  /**
   * Construction sites from live data: empty lot with a sign, scaffolding with a progress bar, the finished
   * building, a guild hall in its colours, or (tavern, market, gate, square) the room's own look, swapped for the
   * new one when its project completes. `celebrate` lists projects that just finished.
   */
  private syncSites(celebrate: readonly string[]) {
    const baked = this.baked;
    if (!baked) return;
    const s = this.opts.store.state;
    const now = performance.now();
    for (const [roomId, site] of Object.entries(baked.sites)) {
      const variant = baked.variants[roomId];
      const kind = site.plot ? 'plot' : variant ? 'variant' : 'other';
      const st = siteState(
        roomId,
        kind,
        { projects: s.projects, buildings: s.buildings, halls: s.halls, roomBuilding: s.rooms.get(roomId)?.building ?? null },
        this.opts.world,
      );
      const key = siteKey(st);
      let v = this.sites.get(roomId);
      if (!v) {
        const box = new Container();
        const bar = new Graphics();
        box.addChild(bar);
        this.sitesLayer.addChild(box);
        v = { room: roomId, key: '', box, sprite: null, overlay: null, statue: null, statueOf: null, bar, lights: [], appearAt: 0, cx: site.x, cy: site.y, w: site.w, h: site.h };
        this.sites.set(roomId, v);
      }
      if (v.key !== key) {
        const wasBuilt = v.key !== '' && !v.key.startsWith('done') && !v.key.startsWith('hall');
        v.key = key;
        for (const sp of [v.sprite, v.overlay, v.statue]) sp?.destroy({ texture: true, textureSource: true });
        v.sprite = v.overlay = v.statue = null;
        for (const l of v.lights) {
          l.sprite.destroy();
          l.pane?.destroy();
        }
        this.lights = this.lights.filter((l) => !v!.lights.includes(l));
        v.lights = [];
        let pic: { art: A.Art; x: number; y: number } | null = null;
        let over: { art: A.Art; x: number; y: number } | null = null;
        const work = () => A.scaffold(Math.min(site.w, roomId === 'village.river_bank' ? 52 : 120), Math.min(site.h, 52), hash32(roomId));
        if (variant) {
          pic = st.mode === 'done' ? variant.done : variant.base;
          if (st.mode === 'work') over = { art: work(), x: site.x, y: site.y };
        } else if (st.mode === 'lot') pic = { art: A.emptyLot(Math.min(site.w, 124), 54), x: site.x, y: site.y };
        else if (st.mode === 'work') pic = { art: work(), x: site.x, y: site.y };
        else if (st.mode === 'hall' && st.hall)
          pic = { art: A.guildHall(A.hexColor(st.hall.colors[0], 0xd9534f), A.hexColor(st.hall.colors[1], 0xf2b84b)), x: site.x, y: site.y + 4 };
        else if (st.mode === 'done')
          pic = {
            art: st.building === 'bridge' && baked.bridge ? A.bridge(baked.bridge.w + 8, baked.bridge.h + 8) : A.projectBuilding(st.building),
            x: site.x,
            y: site.y,
          };
        const add = (p: { art: A.Art; x: number; y: number }) => {
          const sp = new Sprite(canvasTexture(p.art.buf.toCanvas()));
          sp.anchor.set(p.art.ax / p.art.buf.w, p.art.ay / p.art.buf.h);
          sp.position.set(p.x, p.y);
          v!.box.addChildAt(sp, v!.box.children.length - 1);
          for (const l of p.art.lights) {
            const lv = this.makeLight({ ...l, x: p.x - p.art.ax + l.x, y: p.y - p.art.ay + l.y });
            v!.lights.push(lv);
            this.lights.push(lv);
          }
          return sp;
        };
        if (pic) {
          v.sprite = add(pic);
          v.cx = pic.x;
          v.cy = pic.y;
          v.w = pic.art.buf.w;
          v.h = pic.art.buf.h;
        }
        if (over) v.overlay = add(over);
        if (variant?.statueAt && st.mode === 'done') this.placeStatue(v, variant.statueAt);
        const built = st.mode === 'done' || st.mode === 'hall';
        v.appearAt = built && wasBuilt && !this.opts.reducedMotion ? now : 0;
      } else if (variant?.statueAt && st.mode === 'done' && v.statueOf !== (s.honoree?.sprite ?? null)) {
        // the honoree arrives in a `village` delta a moment after the statue completes
        this.placeStatue(v, variant.statueAt);
      }
      v.bar.clear();
      if (st.mode === 'work') {
        const w = 44;
        const x = Math.round(site.x - w / 2);
        const y = Math.round(site.y - Math.min(site.h, 52) - 10);
        v.bar.rect(x - 1, y - 1, w + 2, 7).fill(0x241a2e);
        v.bar.rect(x, y, w, 5).fill(0x4a3d66);
        v.bar.rect(x, y, Math.round(w * st.progress), 5).fill(0xf2b84b);
        v.bar.rect(x, y, Math.round(w * st.progress), 1).fill(0xffe08a);
      }
      if (st.project && celebrate.includes(st.project) && (st.mode === 'done' || st.mode === 'hall')) this.celebrate(v, st.project, now);
    }
  }

  /** The finished project's moment: dust, confetti, a banner with its name, and the director cuts to it. */
  private celebrate(v: SiteView, project: string, now: number) {
    this.effects.celebrate(v.cx, v.cy, Math.min(v.w, 140), Math.min(v.h, 90), now);
    const box = this.makeBanner(i18n.tr.t('ui.map.project_done', { proj: `@proj:${project}` }), 'gold');
    this.banners.push({ box, x: v.cx, y: v.cy - Math.min(v.h, 90) - 14, t0: now, dur: 5200 });
    if (controller.director.enabled && !controller.follow) {
      this.camera.moveTo(v.cx, v.cy - 20, Math.max(this.directorScale(), 2), this.opts.reducedMotion ? 0 : 1100);
      // The project's moment holds the camera; then the director goes back to its star.
      this.director = startMoment(this.director, now, DIRECTOR.projectMs);
      this.opts.store.setTopics('director', [`room:${v.room}`]);
      controller.setDirectorShot(null, v.room, {
        key: 'ui.director.caption.project_done',
        params: { proj: `@proj:${project}` },
      });
    }
  }

  /** The ribbon of the finished-project moment, in a tone; `size` is the font size. */
  private makeBanner(label: string, tone: BannerTone, size = 15): Container {
    const [band, top, bottom, tail] = BANNER_COLORS[tone];
    const box = new Container();
    const text = new Text({
      text: label,
      style: { fontFamily: UI_FONT, fontSize: size, fontWeight: '800', fill: 0x241a2e, letterSpacing: 0.5 },
    });
    text.resolution = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.ceil(text.width) + 28;
    const h = Math.round(size * 1.6);
    const g = new Graphics();
    const INK = 0x241a2e;
    // ribbon tails with a notch, then the band, a 1 px ink outline and a lighter top edge
    g.rect(-w / 2 - 14, -h / 2 + 5, 18, h - 2).fill(INK);
    g.rect(-w / 2 - 13, -h / 2 + 6, 16, h - 4).fill(tail);
    g.rect(-w / 2 - 13, -2, 4, 4).fill(INK);
    g.rect(w / 2 - 4, -h / 2 + 5, 18, h - 2).fill(INK);
    g.rect(w / 2 - 3, -h / 2 + 6, 16, h - 4).fill(tail);
    g.rect(w / 2 + 9, -2, 4, 4).fill(INK);
    g.rect(-w / 2, -h / 2, w, h).fill(INK);
    g.rect(-w / 2 + 1, -h / 2 + 1, w - 2, h - 2).fill(band);
    g.rect(-w / 2 + 1, -h / 2 + 1, w - 2, 2).fill(top);
    g.rect(-w / 2 + 1, h / 2 - 3, w - 2, 2).fill(bottom);
    text.anchor.set(0.5);
    text.position.set(0, 1);
    box.addChild(g, text);
    this.bannerLayer.addChild(box);
    return box;
  }

  /**
   * A big moment of the star: a wide banner above them for about 4 s and a brief push-in. One at a time: a bigger
   * moment replaces the one showing, a smaller one waits for it (only the biggest waiting one is kept).
   */
  private starMoment(m: { key: string; params: Record<string, string | number>; points: number }, now: number) {
    const cur = this.starBanner;
    if (cur && this.banners.includes(cur.banner) && now - cur.banner.t0 < cur.banner.dur) {
      if (m.points <= cur.points) {
        if (!this.pendingBanner || m.points > this.pendingBanner.points) this.pendingBanner = { ...m, at: now };
        return;
      }
      cur.banner.dur = 0;
    }
    const box = this.makeBanner(i18n.tr.t(`ui.director.banner.${m.key}`, m.params), BANNER_TONE[m.key] ?? 'danger', 26);
    const banner: Banner = { box, x: this.camera.x, y: this.camera.y, t0: now, dur: 4000, follow: this.director.star ?? undefined };
    this.banners.push(banner);
    this.starBanner = { banner, points: m.points };
    if (!this.opts.reducedMotion) this.pushUntil = now + 1800;
    // Spoken as it appears (a waiting banner too, when its turn comes).
    directorVoice.banner(m.key, m.params, `${banner.follow ?? ''}|${m.key}|${Math.round(now)}`);
  }

  private updateBanners(now: number) {
    let w = 0;
    for (const b of this.banners) {
      const f = b.dur > 0 ? (now - b.t0) / b.dur : 1;
      if (f >= 1) {
        b.box.destroy({ children: true });
        if (this.starBanner?.banner === b) this.starBanner = null;
        continue;
      }
      if (b.follow) {
        const head = this.agents.head(b.follow, now, this.tmp);
        if (head) {
          b.x = head.x;
          b.y = head.y - 34;
        }
      }
      const p = this.camera.toScreen(b.x, b.y);
      const pop = this.opts.reducedMotion ? 1 : f < 0.08 ? f / 0.08 : 1;
      b.box.position.set(Math.round(p.x), Math.round(p.y - (this.opts.reducedMotion ? 0 : Math.sin(Math.min(1, f * 6) * Math.PI) * 4)));
      b.box.scale.set(pop * (this.opts.reducedMotion ? 1 : 1 + (1 - pop) * 0.3));
      b.box.alpha = f > 0.85 ? (1 - f) / 0.15 : 1;
      b.box.visible = this.lod !== 'dot' || f < 0.5;
      this.banners[w++] = b;
    }
    this.banners.length = w;
    // A waiting star banner follows the one that just ended, if it is still fresh.
    if (!this.starBanner && this.pendingBanner) {
      const m = this.pendingBanner;
      this.pendingBanner = null;
      if (now - m.at < 3000 && this.directorStar()) this.starMoment(m, now);
    }
  }

  /** The statue on the square: the honoree's sprite cast in bronze on the plinth (a cloaked figure until known). */
  private placeStatue(v: SiteView, at: { x: number; y: number }) {
    const draw = (img: CanvasImageSource | null) => {
      if (this.destroyed || !this.sites.has(v.room) || !v.key.startsWith('done')) return;
      const c = document.createElement('canvas');
      c.width = 20;
      c.height = 28;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      try {
        ctx.drawImage(img ?? drawMockSheet('placeholder-silhouette'), 0, 0, 20, 28, 0, 0, 20, 28);
      } catch {
        ctx.drawImage(drawMockSheet('placeholder-silhouette'), 0, 0, 20, 28, 0, 0, 20, 28);
      }
      const bronze = A.bronzeFrame(ctx.getImageData(0, 0, 20, 28).data);
      bronze.outline();
      v.statue?.destroy({ texture: true, textureSource: true });
      const sp = new Sprite(canvasTexture(bronze.toCanvas()));
      sp.anchor.set(0.5, 1);
      sp.position.set(at.x, at.y + 1);
      v.box.addChildAt(sp, v.box.children.length - 1);
      v.statue = sp;
    };
    // The honoree comes with the `village` topic (full and deltas); until then, a cloaked figure.
    const h = this.opts.store.state.honoree;
    v.statueOf = h?.sprite ?? null;
    if (!v.statue) draw(null);
    if (h)
      void this.opts.source
        .spriteImage(h.sprite)
        .then((img) => {
          if (v.statueOf === h.sprite) draw(img);
        })
        .catch(() => undefined);
  }

  private placeInitialCamera() {
    const room = this.rooms().find((r) => r.id === START_ROOM) ?? this.rooms()[0];
    const s = this.opts.zoom ?? this.directorScale();
    if (room) {
      const r = roomPx(room);
      this.camera.moveTo(r.x + r.w / 2, r.y + r.h / 2 + 6, s, 0);
      // The postcard: start on the square for a moment, then the director picks a star.
      this.director = startMoment(initialDirector(), performance.now(), DIRECTOR.welcomeMs);
      controller.setDirectorShot(null, room.id, {
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
    if (ch.rooms) this.rebuildWorld();
    if (ch.rooms || ch.village) this.syncSites(ch.completed);
    for (const ev of ch.events) if (ev.type === 'arrival' && ev.actor) this.pendingArrivals.add(ev.actor);
    this.starEventsIn(ch.events);
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
      case 'wish':
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

    // Follow keeps the camera on the agent; the director's star gets the same tracking.
    const star = this.directorStar();
    const tracked = controller.follow ?? star;
    if (tracked) {
      const p = this.agents.head(tracked, now, this.tmp);
      if (p) {
        const k = Math.min(1, (dt / 1000) * 4);
        // The star sits a little higher, clear of the star card at the bottom of the screen.
        const lift = star && !controller.follow ? (cam.viewH * 0.1) / cam.scale : 0;
        cam.x += (p.x - cam.x) * k;
        cam.y += (p.y + 24 + lift - cam.y) * k;
        if (star && !controller.follow && !cam.moving) {
          // A big moment pushes in briefly; then back to the director's framing.
          const want = this.directorScale() * (now < this.pushUntil ? 1.3 : 1);
          cam.scale += (want - cam.scale) * Math.min(1, (dt / 1000) * 3);
        }
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
    this.drawSpotlight(now, star);
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
    this.updateBanners(now);
    for (const v of this.sites.values()) {
      if (!v.appearAt || !v.sprite) continue;
      const f = Math.min(1, (now - v.appearAt) / 650);
      // grows out of the ground with a small overshoot
      const k = f < 1 ? 1 + 0.12 * Math.sin(f * Math.PI) - (1 - f) * (1 - f) : 1;
      v.sprite.scale.set(1, Math.max(0.05, k));
      if (v.statue) v.statue.visible = f >= 1;
      if (f >= 1) v.appearAt = 0;
    }
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
      const star = this.directorStar();
      for (const v of this.agents.views.values()) {
        if (!v.visible || v.fadeOutAt) continue;
        const p = this.agents.positionAt(v, now, this.tmp);
        if (p.x < view.x + 30 || p.x > view.x + view.w - 30) continue;
        let priority = 0;
        if (
          controller.follow === v.name ||
          star === v.name ||
          (panel?.kind === 'agent' && panel.name === v.name)
        )
          priority = 3;
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
        this.overlay.label(v.name, line, title, at.x, at.y, c.priority === 3, v.name === star);
      }
    }
    this.overlay.endLabels();
  }

  /** The agent the director is following right now, if it is on and not holding a special moment. */
  private directorStar(): string | null {
    if (!controller.director.enabled || controller.follow || this.director.moment) return null;
    return this.director.star;
  }

  /** Resuming the director picks a star right away, avoiding the one shown before the pause. */
  private onDirector() {
    const on = controller.director.enabled;
    if (on === this.directorOn) return;
    this.directorOn = on;
    // Pausing goes live at once (everything held is applied); resuming builds the delay again from zero.
    this.opts.store.setDelay(on);
    if (!on) {
      this.opts.store.setTopics('scout', []);
      // The star card and spotlight belong to the director.
      controller.setStarView({ star: null, now: null, recent: [], why: null });
      this.starOf = '';
    }
    if (!on || !this.ready) return;
    const now0 = performance.now();
    this.director = resumedDirector(this.director, now0);
    this.lastDirectorAt = now0;
    this.directorTick(now0);
  }

  /**
   * The world as the screen shows it (delayed while the director is on), plus what the scout foresees for that
   * display time from the undelayed increments.
   */
  private directorWorld(now: number): DirectorWorld {
    const store = this.opts.store;
    const s = store.state;
    const display = store.displayNow();
    const incs = store.scout.increments();
    return {
      now,
      nowTs: display,
      drama: dramaSnapshot(s, now),
      agents: s.agents,
      logs: s.roomLogs,
      foresight: store.scout.ready
        ? {
            interest: interestAt(incs, display),
            big: bigAhead(incs, display),
            buffered: (room) => store.isBuffered(`room:${room}`),
          }
        : undefined,
    };
  }

  private directorTick(now: number) {
    const store = this.opts.store;
    if (!controller.director.enabled || controller.follow) return;
    const w = this.directorWorld(now);
    const { mem, cut } = directorStep(this.director, w);
    this.director = mem;
    // The scout subscribes early to the rooms of the agents most interesting right now: what is subscribed now is
    // on screen after the lag, when the camera may want it.
    const held = new Set(mem.room ? [mem.room] : []);
    const scoutRooms = store.scout.leaderRooms(now, SCOUT_ROOMS, held);
    store.setTopics(
      'scout',
      scoutRooms.map((r) => `room:${r}`),
    );
    if (config.debug) {
      const top = [...(w.foresight?.interest ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);
      controller.setDirectorDebug({ star: mem.star, top, lagMs: store.lagMs(), scoutRooms: scoutRooms.length });
    }
    // A special moment keeps its own camera, topic and caption.
    if (mem.moment || !mem.star || !mem.room) return;
    const caption = starCaption(mem.star, mem.room, w.logs.get(mem.room) ?? [], w.nowTs);
    store.setTopics('director', [`room:${mem.room}`]);
    if (cut) {
      this.glideTo(cut);
      controller.setDirectorShot(cut.star, cut.room, caption);
    } else controller.updateDirectorShot(mem.room, caption);
    if (this.starOf !== mem.star) this.newStar(mem.star, w);
    // The reason follows the scout: "something big is coming" until it has happened, then what keeps them interesting.
    else if (w.foresight) this.starWhy = reasonFor(store.scout.increments(), mem.star, w.nowTs) ?? this.starWhy;
    this.updateStarView();
  }

  /** A new star: gather what they did lately from the logs, and why the director chose them. */
  private newStar(name: string, w: DirectorWorld) {
    this.starOf = name;
    this.pendingBanner = null;
    this.starActivity = null;
    const seen = new Set<string>();
    const evs: SpectatorEvent[] = [];
    for (const log of w.logs.values())
      for (const ev of log)
        if ((ev.actor === name || ev.target === name || ev.p?.leader === name) && w.nowTs - ev.ts < 120_000 && !seen.has(ev.id)) {
          seen.add(ev.id);
          evs.push(ev);
        }
    this.starEvents = evs.sort((a, b) => a.ts - b.ts).slice(-60);
    this.starWhy = w.foresight ? reasonFor(this.opts.store.scout.increments(), name, w.nowTs) : null;
    const pos = this.opts.store.state.agents.get(name);
    directorVoice.newStar({ name, cls: pos?.c ?? '', level: pos?.l ?? null, room: pos?.r ?? this.director.room ?? '' });
  }

  /** Events as they reach the screen: the star's go to their ring, and a big one gets a banner. */
  private starEventsIn(events: readonly SpectatorEvent[]) {
    const star = this.directorStar();
    if (!star || star !== this.starOf) return;
    let changed = false;
    const now = performance.now();
    const pos = this.opts.store.state.agents.get(star);
    // Spoken director: words said in the star's room, and the star's wishes, as they reach the screen.
    if (pos) directorVoice.events(events, star, pos.r, this.opts.store.state.agents);
    for (const ev of events) {
      if (ev.actor !== star && ev.target !== star && ev.p?.leader !== star) continue;
      this.starEvents.push(ev);
      changed = true;
      const m = bigMoment(ev, star, { bosses: this.bosses, bot: !!pos?.f?.includes('b') });
      if (m) {
        directorVoice.markBanner(ev.ts);
        this.starMoment(m, now);
      }
    }
    if (!changed) return;
    if (this.starEvents.length > 80) this.starEvents.splice(0, this.starEvents.length - 60);
    this.updateStarView();
  }

  /** The star card's data: what the star is doing now, their last actions, and why we are here. */
  private updateStarView() {
    const star = this.directorStar();
    const pos = star ? this.opts.store.state.agents.get(star) : undefined;
    if (!star || !pos) {
      controller.setStarView({ star: null, now: null, recent: [], why: null });
      return;
    }
    // The star's own events plus their room's (another agent answering makes a conversation).
    const byId = new Map<string, SpectatorEvent>();
    for (const ev of this.opts.store.state.roomLogs.get(pos.r) ?? []) if (ev.type === 'say') byId.set(ev.id, ev);
    for (const ev of this.starEvents) byId.set(ev.id, ev);
    const events = [...byId.values()].sort((a, b) => a.ts - b.ts);
    const { now, recent } = starNow(star, events, this.opts.store.displayNow(), {
      bosses: this.bosses,
      room: pos.r,
      fallen: !!pos.f?.includes('d'),
    });
    this.starActivity = now;
    controller.setStarView({ star, now, recent, why: this.starWhy });
    directorVoice.now(star, now);
  }

  /** A soft ring under the star, and a line to the other party of what they are doing (a ring under it too). */
  private drawSpotlight(now: number, star: string | null) {
    const spot = this.spot;
    const link = this.link;
    spot.clear();
    link.clear();
    if (!star || this.lod === 'dot') return;
    const v = this.agents.views.get(star);
    if (!v || !v.visible) return;
    const p = this.agents.positionAt(v, now, { x: 0, y: 0 });
    const act = this.starActivity;
    const color = TONE_COLOR[act?.tone ?? 'gold'] ?? 0xf2b84b;
    const pulse = this.opts.reducedMotion ? 0 : Math.sin(now / 300) * 1.5;
    spot.ellipse(p.x, p.y, 16 + pulse, 6 + pulse / 3).fill({ color, alpha: 0.18 });
    spot.ellipse(p.x, p.y, 12, 4.5).fill({ color, alpha: 0.28 });
    spot.ellipse(p.x, p.y, 14 + pulse, 5.5 + pulse / 3).stroke({ color, alpha: 0.8, width: 1 });
    // Only a fresh action links the two.
    const t = act?.target;
    if (!t || this.opts.store.displayNow() - act.ts > 15_000) return;
    let q: { x: number; y: number } | null = null;
    if (t.kind === 'agent') {
      const o = this.agents.views.get(t.id);
      if (o?.visible) q = this.agents.positionAt(o, now, { x: 0, y: 0 });
    } else {
      const m = this.monsters.find((x) => x.room === v.pos.r && x.kind === t.id && x.alive && x.hiddenUntil < now);
      if (m) q = { x: m.x, y: m.y };
    }
    if (!q) return;
    link.ellipse(q.x, q.y, 12, 4.5).stroke({ color, alpha: 0.9, width: 1 });
    // a thin dashed line between the two, at waist height
    const ax = p.x;
    const ay = p.y - 10;
    const bx = q.x;
    const by = q.y - 10;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.floor(len / 6));
    for (let i = 0; i < n; i += 2) {
      const f0 = i / n;
      const f1 = Math.min(1, (i + 1) / n);
      link.moveTo(ax + (bx - ax) * f0, ay + (by - ay) * f0).lineTo(ax + (bx - ax) * f1, ay + (by - ay) * f1);
    }
    link.stroke({ color, alpha: 0.85, width: 1 });
  }

  /** The cut to a new star: an eased move onto them, after which the frame keeps tracking them. */
  private glideTo(cut: Cut) {
    const now = performance.now();
    const p = this.agents.head(cut.star, now, { x: 0, y: 0 });
    let x: number;
    let y: number;
    if (p) {
      x = p.x;
      y = p.y + 24 + (this.camera.viewH * 0.1) / this.directorScale();
    } else {
      const room = this.rooms().find((r) => r.id === cut.room);
      if (!room) return;
      const r = roomPx(room);
      x = r.x + r.w / 2;
      y = r.y + r.h / 2 + 6;
    }
    this.camera.moveTo(x, y, this.directorScale(), this.opts.reducedMotion ? 0 : 1300);
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
