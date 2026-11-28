/**
 * The live activity log. Every string here came from the core and is rendered as plain text: no markup, no links.
 * Words written by other players' agents are boxed and labelled as such.
 */
import { memo, useEffect, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, Text, View } from 'react-native';
import type { LogEntry } from '../core/types';
import { useI18n } from '../i18n/context';
import { formatNumber, formatTime } from '../i18n/i18n';
import { useReducedMotion } from '../state/hooks';
import type { LogState } from '../state/reducer';
import { PixelButton } from './kit';
import { C, FONT, SPACE } from './theme';

function Delta({ d }: { d: NonNullable<LogEntry['delta']> }) {
  const { t, lang } = useI18n();
  const chips: { text: string; color: string }[] = [];
  if (d.level) chips.push({ text: t('log.deltaLevel'), color: C.amber });
  if (d.xp) chips.push({ text: t('log.deltaXp', { n: d.xp }), color: C.xp });
  if (d.gold) chips.push({ text: t('log.deltaGold', { n: `${d.gold > 0 ? '+' : ''}${formatNumber(lang, d.gold)}` }), color: d.gold > 0 ? C.amber : C.red });
  if (d.hp) chips.push({ text: t('log.deltaHp', { n: `${d.hp > 0 ? '+' : ''}${formatNumber(lang, d.hp)}` }), color: d.hp > 0 ? C.teal : C.hp });
  if (chips.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
      {chips.map((c, i) => (
        <Text key={i} style={{ color: c.color, fontSize: 11, fontWeight: '700', fontFamily: FONT.mono, borderWidth: 1, borderColor: c.color, paddingHorizontal: 4 }}>
          {c.text}
        </Text>
      ))}
    </View>
  );
}

export const LogItem = memo(function LogItem({ e, name, fresh }: { e: LogEntry; name: string; fresh: boolean }) {
  const { t, lang } = useI18n();
  const reduced = useReducedMotion();
  const [a] = useState(() => new Animated.Value(fresh && !reduced ? 0 : 1));
  useEffect(() => {
    if (fresh && !reduced) Animated.timing(a, { toValue: 1, duration: 450, useNativeDriver: false }).start();
  }, [a, fresh, reduced]);
  const accent = e.big ? C.amber : e.kind === 'refused' ? C.red : e.kind === 'event' ? C.teal : e.kind === 'system' ? C.faint : C.edge;
  const translateY = a.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] });
  return (
    <Animated.View
      style={{
        opacity: a,
        transform: [{ translateY }],
        borderLeftWidth: e.big ? 4 : 2,
        borderLeftColor: accent,
        backgroundColor: e.big ? 'rgba(242,184,75,0.10)' : 'transparent',
        paddingVertical: 6,
        paddingHorizontal: SPACE.s,
        marginBottom: 6,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <Text style={{ color: C.faint, fontSize: 11, fontFamily: FONT.mono }}>{formatTime(lang, e.ts)}</Text>
        {e.kind === 'refused' ? <Text style={{ color: C.red, fontSize: 11, fontWeight: '700' }}>{t('log.refused')}</Text> : null}
        {e.kind === 'system' ? <Text style={{ color: C.faint, fontSize: 11, fontWeight: '700' }}>{t('log.system')}</Text> : null}
        {e.action ? <Text style={{ color: C.faint, fontSize: 11, fontFamily: FONT.mono }}>{e.action}</Text> : null}
      </View>
      {e.thought ? (
        <Text style={{ color: C.muted, fontStyle: 'italic', fontSize: 13, marginBottom: 3 }}>
          <Text style={{ fontWeight: '700', fontStyle: 'normal' }}>
            {name} {t('log.thought')}:{' '}
          </Text>
          {e.thought}
        </Text>
      ) : null}
      <Text
        selectable
        style={{ color: e.kind === 'system' ? C.muted : C.text, fontSize: e.big ? 16 : 14, fontWeight: e.big ? '700' : '400', lineHeight: e.big ? 22 : 20, fontFamily: e.big ? FONT.serif : FONT.sans }}
      >
        {e.text}
      </Text>
      {e.quote ? (
        <View
          accessible
          accessibilityLabel={`${t('log.otherPlayerA11y', { name: e.quote.from })} ${e.quote.text}`}
          style={{ marginTop: 4, backgroundColor: C.trough, borderWidth: 1, borderColor: C.edge, borderStyle: 'dashed', padding: SPACE.s }}
        >
          <Text style={{ color: C.faint, fontSize: 11, fontWeight: '700', marginBottom: 2 }}>{t('log.otherPlayer', { name: e.quote.from })}</Text>
          <Text selectable style={{ color: C.muted, fontSize: 14, fontFamily: FONT.serif }}>
            “{e.quote.text}”
          </Text>
        </View>
      ) : null}
      {e.delta ? <Delta d={e.delta} /> : null}
    </Animated.View>
  );
});

export function LogList({
  log,
  name,
  onOlder,
  header,
}: {
  log: LogState | undefined;
  name: string;
  onOlder: () => void;
  header?: React.ReactElement | null;
}) {
  const { t } = useI18n();
  const [opened] = useState(() => Date.now());
  const entries = log?.entries ?? [];
  const footer = !log || log.loading ? (
    <View style={{ padding: SPACE.m, alignItems: 'center' }}>
      <ActivityIndicator color={C.amber} accessibilityLabel={t('log.loadingOlder')} />
    </View>
  ) : log.exhausted ? (
    <Text style={{ color: C.faint, textAlign: 'center', padding: SPACE.m, fontStyle: 'italic' }}>{entries.length ? t('log.end') : t('log.empty')}</Text>
  ) : (
    <View style={{ padding: SPACE.s, alignItems: 'center' }}>
      <PixelButton small label={t('log.loadOlder')} onPress={onOlder} />
    </View>
  );
  return (
    <FlatList
      data={entries}
      keyExtractor={(e) => e.id}
      renderItem={({ item }) => <LogItem e={item} name={name} fresh={item.ts > opened} />}
      onEndReached={onOlder}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={header ?? undefined}
      ListFooterComponent={footer}
      accessibilityLabel={t('log.label')}
      initialNumToRender={20}
      windowSize={9}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingVertical: SPACE.s }}
    />
  );
}
