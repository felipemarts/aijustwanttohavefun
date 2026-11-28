/** Screen frame: top bar with navigation, the engine and server strip, and a centred content column. */
import { router, usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n/context';
import { formatNumber } from '../i18n/i18n';
import { useAppState, useStore, useWide } from '../state/hooks';
import { Dot } from './kit';
import { C, FONT, SPACE } from './theme';

const NAV = [
  { href: '/', key: 'nav.home' },
  { href: '/engine', key: 'nav.engine' },
  { href: '/settings', key: 'nav.settings' },
] as const;

export function TopBar({ back }: { back?: boolean }) {
  const { t } = useI18n();
  const wide = useWide();
  const path = usePathname();
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const nav = (
    <View role="navigation" aria-label={t('nav.menu')} style={{ flexDirection: 'row', gap: 2, flexShrink: 0 }}>
      {NAV.map((n) => {
        const on = path === n.href;
        return (
          <Pressable
            key={n.href}
            onPress={() => router.navigate(n.href)}
            accessibilityRole="link"
            accessibilityState={{ selected: on }}
            aria-current={on ? 'page' : undefined}
            style={{
              flex: wide ? undefined : 1,
              paddingHorizontal: SPACE.m,
              minHeight: 40,
              justifyContent: 'center',
              alignItems: 'center',
              borderBottomWidth: 3,
              borderBottomColor: on ? C.amber : 'transparent',
            }}
          >
            <Text numberOfLines={1} style={{ color: on ? C.amber : C.muted, fontWeight: '700', fontSize: 14, fontFamily: FONT.sans }}>
              {t(n.key)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <View style={{ backgroundColor: C.panel, borderBottomWidth: 2, borderBottomColor: C.edge }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.m, minHeight: 48, gap: SPACE.s, maxWidth: 1280, width: '100%', alignSelf: 'center' }}>
        {back ? (
          <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel={t('nav.back')} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: C.amber, fontSize: 22, fontWeight: '700' }} aria-hidden>
              ‹
            </Text>
          </Pressable>
        ) : null}
        <Text numberOfLines={1} role="heading" aria-level={1} style={{ flex: 1, color: C.amber, fontFamily: FONT.serif, fontSize: 18, fontWeight: '700' }}>
          {t('app.title')}
        </Text>
        {wide ? nav : null}
      </View>
      {wide ? null : nav}
    </View>
  );
}

export function StatusStrip() {
  const { t, lang } = useI18n();
  const s = useAppState();
  const store = useStore();
  const core = s.core;
  if (!core) return null;
  const e = core.engine;
  const pct = e.builtin && e.builtin.bytesTotal > 0 ? Math.floor((e.builtin.bytesDone / e.builtin.bytesTotal) * 100) : 0;
  const engineColor = e.status === 'ready' ? C.teal : e.status === 'downloading' || e.status === 'starting' ? C.amber : C.red;
  const conn = s.connection === 'connecting' || s.connection === 'reconnecting' || s.connection === 'unauthorized' ? s.connection : null;
  const item = { flexDirection: 'row', alignItems: 'center', gap: 6 } as const;
  const small = { color: C.muted, fontSize: 12, fontFamily: FONT.sans } as const;
  return (
    <Pressable
      onPress={() => router.navigate('/engine')}
      accessibilityRole="link"
      accessibilityLabel={`${t('strip.engine')}: ${t(`engine.status.${e.status}`, { percent: pct })}. ${t('strip.server')}: ${core.server.reachable ? t('strip.serverUp') : t('strip.serverDown')}`}
      style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: SPACE.l, rowGap: 4, paddingHorizontal: SPACE.m, paddingVertical: 6, backgroundColor: C.trough, borderBottomWidth: 1, borderBottomColor: C.edgeDark }}
    >
      <View style={item}>
        <Dot color={engineColor} pulse={e.status === 'downloading' || e.status === 'starting'} />
        <Text style={small}>
          {t('strip.engine')}: <Text style={{ color: C.text }}>{t(`engine.status.${e.status}`, { percent: pct })}</Text>
          {e.status === 'ready' && e.tokensPerSecond ? ` · ${t('strip.tps', { tps: formatNumber(lang, e.tokensPerSecond, 1) })}` : ''}
        </Text>
      </View>
      <View style={item}>
        <Dot color={core.server.reachable ? C.teal : C.red} />
        <Text style={small}>
          {t('strip.server')}: <Text style={{ color: C.text }}>{core.server.reachable ? t('strip.serverUp') : t('strip.serverDown')}</Text>
        </Text>
      </View>
      {conn ? (
        <View style={item} role="status">
          <Dot color={conn === 'unauthorized' ? C.red : C.amber} pulse={conn !== 'unauthorized'} />
          <Text style={[small, { color: conn === 'unauthorized' ? C.red : C.amber }]}>{t(`conn.${conn}`)}</Text>
        </View>
      ) : null}
      {store.kind === 'mock' || store.kind === 'mock-empty' ? (
        <View style={item}>
          <Text style={[small, { color: C.faint }]}>{t('strip.mock')}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A screen: bars on top, then content in a column no wider than `max`. Scrolls unless `fixed`. */
export function Screen({
  children,
  back,
  fixed,
  max = 1200,
  contentStyle,
}: {
  children: ReactNode;
  back?: boolean;
  fixed?: boolean;
  max?: number;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const inner = <View style={[{ width: '100%', maxWidth: max, alignSelf: 'center', padding: SPACE.m }, fixed ? { flex: 1 } : null, contentStyle]}>{children}</View>;
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: C.bg }}>
      <TopBar back={back} />
      <StatusStrip />
      {fixed ? (
        <View style={{ flex: 1 }}>{inner}</View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: SPACE.xl }} keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
