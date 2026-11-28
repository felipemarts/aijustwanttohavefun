import { router } from 'expo-router';
/** Pieces that show a character: status line, gauges, level-up moment, the home card and the "away" panel. */
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, Text, View } from 'react-native';
import type { AwaySummary, CharacterSummary, LogEntry } from '../core/types';
import { useI18n } from '../i18n/context';
import { formatAgo, formatCountdown, formatDateTime, formatNumber, formatTime } from '../i18n/i18n';
import type { Celebration } from '../state/reducer';
import { useAppState, useNow, useReducedMotion, useStore } from '../state/hooks';
import { Bar, Body, Dot, Heading, PixelBox, PixelButton, useTicking } from './kit';
import { latestNews, stuckReason, type StuckReason } from './progress';
import Sprite from './Sprite';
import { C, CLASS_COLOR, FONT, SPACE, STATUS_COLOR } from './theme';

function statusLabel(c: CharacterSummary, t: (k: string, p?: Record<string, string | number>) => string, lang: string): string {
  if (c.status === 'resting' && c.nextActionAt) return t('status.restingUntil', { time: formatTime(lang, c.nextActionAt) });
  return t(`status.${c.status}`);
}

/** Compares two short labels loosely: case, spaces and trailing dots or ellipses do not count ("Thinking…" = "Thinking"). */
function sameLabel(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s.…。]+$/u, '').replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

/** The one-line activity, unless it only repeats the status line (or the problem, when blocked). */
export function activityLine(c: CharacterSummary, t: (k: string, p?: Record<string, string | number>) => string, lang: string): string | null {
  const text = c.status === 'blocked' && c.problem ? c.problem : c.activity;
  if (!text || sameLabel(text, statusLabel(c, t, lang))) return null;
  return text;
}

/** Before the core's first sync with the game the summary has no room and empty gauges. */
export function synced(c: CharacterSummary): boolean {
  return c.hp[1] > 0 || c.room.name.trim() !== '';
}

/** What it did last (or the last big moment), with how long ago: the card's answer to "what is it up to?". */
export function NewsLine({ entries }: { entries: LogEntry[] | undefined }) {
  const { t, lang } = useI18n();
  const now = useNow(15_000);
  const news = entries ? latestNews(entries, now) : null;
  if (!news) return null;
  const ago = formatAgo(lang, news.entry.ts, now);
  return (
    <View
      accessible
      accessibilityLabel={t('card.latestA11y', { ago, text: news.entry.text })}
      style={{ flexDirection: 'row', gap: 6, alignItems: 'baseline', borderLeftWidth: 2, borderLeftColor: news.big ? C.amber : C.edge, paddingLeft: 6 }}
    >
      <Text style={{ color: C.faint, fontSize: 11, fontFamily: FONT.mono, flexShrink: 0 }}>{ago}</Text>
      <Text numberOfLines={2} style={{ color: news.big ? C.amber : C.muted, fontSize: 13, fontWeight: news.big ? '700' : '400', flexShrink: 1 }}>
        {news.entry.text}
      </Text>
    </View>
  );
}

/** The "seems stuck" chip and its Nudge button. */
export function StuckChip({ reason, onNudge }: { reason: StuckReason; onNudge: () => void }) {
  const { t } = useI18n();
  return (
    <View role="status" style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s, flexWrap: 'wrap', borderWidth: 1, borderColor: C.amberDim, borderStyle: 'dashed', padding: 6 }}>
      <Text style={{ color: C.amber, fontWeight: '700', fontSize: 13 }}>{t('stuck.label')}</Text>
      <Text style={{ color: C.muted, fontSize: 12, flexShrink: 1, flexGrow: 1 }}>{t(`stuck.${reason}`)}</Text>
      <PixelButton small kind="primary" label={t('stuck.nudge')} a11yHint={t('stuck.nudgeHint')} onPress={onNudge} />
    </View>
  );
}


/** After this long "thinking" the line shows for how long; after SLOW_ENGINE_MS a warning offers the engine screen. */
export const THINKING_SHOWN_MS = 20_000;
export const SLOW_ENGINE_MS = 90_000;

/** How long a character has been thinking, from the status changes this page saw; 0 when it is not thinking. */
export function useThinkingFor(c: CharacterSummary): number {
  const s = useAppState();
  const now = useNow(1000);
  const since = s.statusSince[c.id];
  return c.status === 'thinking' && since ? Math.max(0, now - since) : 0;
}

export function StatusLine({ c }: { c: CharacterSummary }) {
  const { t, lang } = useI18n();
  const now = useNow(1000);
  const thinkingFor = useThinkingFor(c);
  const color = STATUS_COLOR[c.status] ?? C.muted;
  const label = statusLabel(c, t, lang);
  const next =
    c.status === 'resting' && c.nextActionAt && c.nextActionAt > now
      ? t('status.nextIn', { time: formatCountdown(c.nextActionAt - now) })
      : thinkingFor >= THINKING_SHOWN_MS
        ? t('status.thinkingFor', { time: formatCountdown(thinkingFor) })
        : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Dot color={color} pulse={c.status === 'thinking'} />
      <Text style={{ color, fontWeight: '700', fontSize: 13 }}>{label}</Text>
      {next ? <Text style={{ color: thinkingFor >= SLOW_ENGINE_MS ? C.amber : C.faint, fontSize: 12 }}>· {next}</Text> : null}
    </View>
  );
}

/** Shown when the AI has not answered for a long time: the owner can only act on the engine, so link to it. */
export function SlowEngine({ c }: { c: CharacterSummary }) {
  const { t } = useI18n();
  const thinkingFor = useThinkingFor(c);
  if (thinkingFor < SLOW_ENGINE_MS) return null;
  return (
    <View role="status" style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s, flexWrap: 'wrap', borderWidth: 1, borderColor: C.amberDim, borderStyle: 'dashed', padding: 6 }}>
      <Text style={{ color: C.amber, fontSize: 13, flexShrink: 1, flexGrow: 1 }}>{t('slow.title', { time: formatCountdown(thinkingFor) })}</Text>
      <PixelButton small label={t('slow.action')} onPress={() => router.navigate('/engine')} />
    </View>
  );
}

function SmallGauge({ label, g, color }: { label: string; g: [number, number]; color: string }) {
  const { t, lang } = useI18n();
  const v = useTicking(g[0]);
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
        <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: C.muted, fontSize: 11, fontFamily: FONT.mono }} numberOfLines={1}>
          {formatNumber(lang, v)}/{formatNumber(lang, g[1])}
        </Text>
      </View>
      <Bar value={g[0]} max={g[1]} color={color} height={8} label={t('card.bar', { label, value: g[0], max: g[1] })} />
    </View>
  );
}

export function Gauges({ c }: { c: CharacterSummary }) {
  const { t, lang } = useI18n();
  const xp = useTicking(c.xp[0]);
  return (
    <View style={{ gap: SPACE.s }}>
      <View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
          <Text style={{ color: C.xp, fontSize: 11, fontWeight: '700' }}>{t('card.xp')}</Text>
          <Text style={{ color: C.muted, fontSize: 11, fontFamily: FONT.mono }}>
            {formatNumber(lang, xp)}/{formatNumber(lang, c.xp[1])}
          </Text>
        </View>
        <Bar value={c.xp[0]} max={c.xp[1]} color={C.xp} height={12} label={t('card.bar', { label: t('card.xp'), value: c.xp[0], max: c.xp[1] })} />
      </View>
      <View style={{ flexDirection: 'row', gap: SPACE.s }}>
        <SmallGauge label={t('card.hp')} g={c.hp} color={C.hp} />
        <SmallGauge label={t('card.mp')} g={c.mp} color={C.mp} />
        <SmallGauge label={t('card.ap')} g={c.ap} color={C.ap} />
      </View>
    </View>
  );
}

export function Gold({ value }: { value: number }) {
  const { t, lang } = useI18n();
  const v = useTicking(value);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View aria-hidden style={{ width: 10, height: 10, backgroundColor: C.amber, borderWidth: 1, borderColor: '#ffd98a' }} />
      <Text style={{ color: C.muted, fontSize: 12 }}>{t('card.gold')}</Text>
      <Text style={{ color: C.amber, fontWeight: '700', fontFamily: FONT.mono, fontSize: 14 }}>{formatNumber(lang, v)}</Text>
    </View>
  );
}

/** The level-up moment: a golden banner that pops in, is announced to screen readers, and fades after a while. */
export function LevelUpBanner({ c, celebration }: { c: CharacterSummary; celebration: Celebration | undefined }) {
  const { t } = useI18n();
  const store = useStore();
  const reduced = useReducedMotion();
  const [a] = useState(() => new Animated.Value(0));
  const at = celebration?.at;
  useEffect(() => {
    if (!at) return;
    AccessibilityInfo.announceForAccessibility(t('card.levelUpTo', { name: c.name, level: c.level }));
    a.setValue(reduced ? 1 : 0);
    if (!reduced) Animated.spring(a, { toValue: 1, friction: 4, tension: 80, useNativeDriver: false }).start();
    // Long enough to notice from across the room: this is an idle game, often watched from the corner of an eye.
    const timer = setTimeout(() => store.dispatch({ t: 'clearCelebration', id: c.id }), 15_000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  if (!celebration) return null;
  const scale = a.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: SPACE.s,
        right: SPACE.s,
        opacity: a,
        transform: [{ scale }, { rotate: '-3deg' }],
        backgroundColor: C.amber,
        borderWidth: 2,
        borderColor: '#ffd98a',
        borderBottomWidth: 4,
        paddingHorizontal: SPACE.m,
        paddingVertical: 4,
        zIndex: 5,
      }}
    >
      <Text style={{ color: C.ink, fontWeight: '900', fontSize: 14, fontFamily: FONT.serif }}>{t('card.levelUp')}</Text>
      <Text style={{ color: C.ink, fontWeight: '700', fontSize: 12, textAlign: 'center' }}>{t('card.level', { level: celebration.level })}</Text>
    </Animated.View>
  );
}

/** Name, class, level and title: the line under a sprite. */
export function NameBlock({ c, big }: { c: CharacterSummary; big?: boolean }) {
  const { t } = useI18n();
  const color = CLASS_COLOR[c.class] ?? C.text;
  return (
    <View style={{ minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: C.text, fontFamily: FONT.serif, fontWeight: '700', fontSize: big ? 24 : 19 }}>
        {c.name}
      </Text>
      <Text numberOfLines={1} style={{ color: C.muted, fontSize: 13, marginTop: 1 }}>
        <Text style={{ color, fontWeight: '700' }}>{t(`class.${c.class}`)}</Text>
        {' · '}
        {t('card.level', { level: c.level })}
        {c.title ? ` · ${c.title}` : ''}
      </Text>
    </View>
  );
}

export function CharacterCard({
  c,
  celebration,
  recent,
  onOpen,
  onNudge,
}: {
  c: CharacterSummary;
  celebration?: Celebration;
  recent?: LogEntry[];
  onOpen: () => void;
  onNudge: () => void;
}) {
  const { t, lang } = useI18n();
  const activity = activityLine(c, t, lang);
  const s = useAppState();
  const stuck = stuckReason(c, s.coreReportsStuck, recent);
  const ready = synced(c);
  const classColor = CLASS_COLOR[c.class] ?? C.edge;
  return (
    <PixelBox edge={celebration ? C.amber : C.edge} pad={0} style={{ flex: 1 }}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="link"
        accessibilityLabel={t('card.open', { name: c.name })}
        style={(state) => ({ padding: SPACE.m, backgroundColor: (state as { hovered?: boolean }).hovered ? C.panelHi : 'transparent' })}
      >
        <View style={{ flexDirection: 'row', gap: SPACE.m }}>
          <View style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2, backgroundColor: C.trough, borderBottomWidth: 3, borderBottomColor: classColor, paddingHorizontal: 6, paddingTop: 6 }}>
            <Sprite uri={c.sprite} status={c.status} pixel={3} color={classColor} initial={c.name.slice(0, 1).toUpperCase()} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <NameBlock c={c} />
            <StatusLine c={c} />
            {activity ? (
              <Text numberOfLines={2} style={{ color: C.text, fontStyle: 'italic', fontSize: 14, opacity: 0.9 }}>
                {activity}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={{ marginTop: SPACE.s }}>
          <NewsLine entries={recent} />
        </View>
        <View style={{ marginTop: SPACE.m }}>
          {ready ? <Gauges c={c} /> : <Text style={{ color: C.faint, fontStyle: 'italic', fontSize: 13 }}>{t('card.syncing')}</Text>}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACE.m, gap: SPACE.s, flexWrap: 'wrap' }}>
          <Gold value={c.gold} />
          {c.room.name.trim() ? (
            <Text numberOfLines={1} style={{ color: C.muted, fontSize: 12, flexShrink: 1 }}>
              {t('card.where', { room: c.room.name })}
            </Text>
          ) : null}
          {!c.claimed ? (
            <Text style={{ color: C.amber, fontSize: 11, fontWeight: '700', borderWidth: 1, borderColor: C.amberDim, paddingHorizontal: 6, paddingVertical: 1 }}>
              {t('card.unclaimed')}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <View style={{ paddingHorizontal: SPACE.m }}>
        <SlowEngine c={c} />
      </View>
      {stuck ? (
        <View style={{ paddingHorizontal: SPACE.m, paddingBottom: SPACE.m }}>
          <StuckChip reason={stuck} onNudge={onNudge} />
        </View>
      ) : null}
      <LevelUpBanner c={c} celebration={celebration} />
    </PixelBox>
  );
}

function AwayRow({ c, away, onOpen }: { c: CharacterSummary; away: AwaySummary; onOpen: () => void }) {
  const { t, lang } = useI18n();
  const now = useNow(60_000);
  const stats = [
    t('away.actions', { count: away.actions }),
    away.levels > 0 ? t('away.levels', { count: away.levels }) : null,
    away.xp > 0 ? t('away.xp', { count: away.xp }) : null,
    away.gold !== 0 ? t('away.gold', { count: away.gold }) : null,
    away.kills > 0 ? t('away.kills', { count: away.kills }) : null,
    away.deaths > 0 ? t('away.deaths', { count: away.deaths }) : null,
  ].filter(Boolean);
  return (
    <View style={{ paddingVertical: SPACE.s, borderTopWidth: 1, borderTopColor: C.edgeDark }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: SPACE.s, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontFamily: FONT.serif, fontWeight: '700', fontSize: 17 }}>{c.name}</Text>
        <Text style={{ color: C.faint, fontSize: 12 }}>{t('away.since', { time: now - away.since < 20 * 3600_000 ? formatTime(lang, away.since) : formatDateTime(lang, away.since) })}</Text>
      </View>
      <Text style={{ color: C.amber, fontSize: 13, marginTop: 2 }}>{stats.join(' · ')}</Text>
      {away.highlights.slice(0, 5).map((h, i) => (
        <Body key={i} style={{ fontSize: 14, marginTop: 2 }}>
          {'• '}
          {h}
        </Body>
      ))}
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        <PixelButton small label={t('away.open', { name: c.name })} onPress={onOpen} />
      </View>
    </View>
  );
}

export function AwayPanel({ characters, onOpen }: { characters: CharacterSummary[]; onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const store = useStore();
  const rows = characters.filter((c) => c.away);
  if (rows.length === 0) return null;
  const dismiss = () => {
    for (const c of rows) void store.seen(c.id).catch(() => {});
  };
  return (
    <PixelBox edge={C.amberDim} style={{ marginBottom: SPACE.m }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Heading level={2} style={{ color: C.amber, marginBottom: 0 }}>
          {t('away.title')}
        </Heading>
        <PixelButton small kind="ghost" label={t('away.dismiss')} onPress={dismiss} />
      </View>
      {rows.map((c) => (
        <AwayRow key={c.id} c={c} away={c.away!} onOpen={() => onOpen(c.id)} />
      ))}
    </PixelBox>
  );
}

