import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CharacterSummary } from '../core/types';
import { errorText, useI18n } from '../i18n/context';
import { useAppState, useStore, useWide } from '../state/hooks';
import { failureOf } from '../state/store';
import { activityLine, Gauges, Gold, LevelUpBanner, NameBlock, SlowEngine, StatusLine, StuckChip, synced } from '../ui/character-bits';
import { GuidanceTab, SheetTab, TalkTab } from '../ui/character-tabs';
import { Screen } from '../ui/chrome';
import { Confirm } from '../ui/Confirm';
import { Body, Notice, PixelBox, PixelButton } from '../ui/kit';
import { openExternal, openExternalLater, safeHttpUrl } from '../ui/links';
import { LogList } from '../ui/log';
import Sprite from '../ui/Sprite';
import { nudgeSuggestion, stuckReason } from '../ui/progress';
import { C, CLASS_COLOR, SPACE } from '../ui/theme';

type Tab = 'activity' | 'sheet' | 'talk' | 'guidance';
const TABS: Tab[] = ['activity', 'sheet', 'talk', 'guidance'];

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { t } = useI18n();
  return (
    <View role="tablist" aria-label={t('tab.label')} style={{ flexDirection: 'row', borderBottomWidth: 2, borderBottomColor: C.edge, marginTop: SPACE.s }}>
      {TABS.map((k) => {
        const on = k === tab;
        return (
          <Pressable
            key={k}
            onPress={() => setTab(k)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={{
              flex: 1,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? C.panelHi : 'transparent',
              borderTopWidth: 2,
              borderLeftWidth: 2,
              borderRightWidth: 2,
              borderColor: on ? C.edge : 'transparent',
              marginBottom: -2,
              borderBottomWidth: 2,
              borderBottomColor: on ? C.panelHi : 'transparent',
            }}
          >
            <Text numberOfLines={1} style={{ color: on ? C.amber : C.muted, fontWeight: '700', fontSize: 14 }}>
              {t(`tab.${k}`)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Actions({ c, onForget }: { c: CharacterSummary; onForget: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = c.status !== 'paused';
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await store.control(c.id, !running);
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setBusy(false);
    }
  };
  const [claiming, setClaiming] = useState(false);
  const claim = async () => {
    setClaiming(true);
    setErr(null);
    try {
      // Asked for only now, opened at once, never kept: the link makes whoever opens it first the owner.
      const opened = await openExternalLater(() => store.core!.claimLink(c.id));
      if (!opened) setErr(t('char.claimGone'));
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setClaiming(false);
    }
  };
  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        <PixelButton small kind={running ? 'secondary' : 'primary'} icon={running ? '❚❚' : '▶'} label={running ? t('char.pause') : t('char.play')} onPress={() => void toggle()} busy={busy} />
        {safeHttpUrl(c.watchUrl) ? <PixelButton small label={t('char.watch')} icon="↗" a11yHint={c.watchUrl} onPress={() => void openExternal(c.watchUrl)} /> : null}
        <PixelButton small kind="ghost" label={t('char.forget')} onPress={onForget} />
      </View>
      {c.claimPending ? (
        <View style={{ marginTop: SPACE.s, borderWidth: 2, borderColor: C.amberDim, borderStyle: 'dashed', padding: SPACE.s, gap: SPACE.s }}>
          <Body style={{ fontSize: 14 }}>{t('char.claimWhy')}</Body>
          <View style={{ flexDirection: 'row' }}>
            <PixelButton small kind="primary" icon="↗" label={t('char.claim')} busy={claiming} onPress={() => void claim()} />
          </View>
        </View>
      ) : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
    </View>
  );
}

function Summary({ c, wide, onForget }: { c: CharacterSummary; wide: boolean; onForget: () => void }) {
  const { t, lang } = useI18n();
  const activity = activityLine(c, t, lang);
  const s = useAppState();
  const color = CLASS_COLOR[c.class] ?? C.edge;
  return (
    <PixelBox edge={s.celebrations[c.id] ? C.amber : C.edge}>
      <View style={{ flexDirection: wide ? 'column' : 'row', gap: SPACE.m, alignItems: wide ? 'center' : 'flex-start' }}>
        <View style={{ backgroundColor: C.trough, padding: 6, borderBottomWidth: 3, borderBottomColor: color, alignSelf: wide ? 'stretch' : 'auto', alignItems: 'center' }}>
          <Sprite uri={c.sprite} status={c.status} pixel={wide ? 6 : 3} color={color} initial={c.name.slice(0, 1).toUpperCase()} />
        </View>
        <View style={{ flex: wide ? undefined : 1, alignSelf: 'stretch', minWidth: 0, gap: 4 }}>
          <NameBlock c={c} big={wide} />
          <StatusLine c={c} />
          {activity ? (
            <Text numberOfLines={2} style={{ color: c.status === 'blocked' ? C.red : C.text, fontStyle: 'italic', fontSize: 14 }}>
              {activity}
            </Text>
          ) : null}
          {c.room.name.trim() ? (
            <Text numberOfLines={1} style={{ color: C.muted, fontSize: 12 }}>
              {t('card.where', { room: c.room.name })}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ marginTop: SPACE.m, gap: SPACE.s }}>
        {synced(c) ? <Gauges c={c} /> : <Text style={{ color: C.faint, fontStyle: 'italic', fontSize: 13 }}>{t('card.syncing')}</Text>}
        <Gold value={c.gold} />
        <Actions c={c} onForget={onForget} />
      </View>
      <LevelUpBanner c={c} celebration={s.celebrations[c.id]} />
    </PixelBox>
  );
}

export default function CharacterScreen() {
  const i18n = useI18n();
  const { t } = i18n;
  const { id: rawId, tab: rawTab, nudge } = useLocalSearchParams<{ id?: string; tab?: string; nudge?: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const s = useAppState();
  const store = useStore();
  const wide = useWide();
  const [tab, setTab] = useState<Tab>(TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'activity');
  // A nudge (from the "seems stuck" signal) opens Talk in Command mode with a suggestion; it is used once.
  const [nudging, setNudging] = useState(nudge === '1');
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = s.characters.find((x) => x.id === id);
  const ready = s.phase === 'ready';
  const exists = !!c;

  useEffect(() => {
    if (!ready || !exists) return;
    store.openCharacter(id).catch((e) => setErr(errorText(i18n, failureOf(e))));
    // Opening the character is looking at it: its "while you were away" summary has been seen.
    if (store.state.characters.find((x) => x.id === id)?.away) void store.seen(id).catch(() => {});
    void store.openLog(id);
    void store.loadChat(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ready, exists, store]);

  if (!c) {
    return (
      <Screen back max={640}>
        <PixelBox>
          <Body>{ready ? t('char.notFound') : t('common.loading')}</Body>
        </PixelBox>
      </Screen>
    );
  }

  const forget = async () => {
    if (!store.core) return;
    setForgetBusy(true);
    try {
      await store.core.forget(c.id);
      setForgetOpen(false);
      router.replace('/');
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
      setForgetOpen(false);
    } finally {
      setForgetBusy(false);
    }
  };

  const detail = s.details[id];
  const tabs = <Tabs tab={tab} setTab={setTab} />;
  const stuck = stuckReason(c, s.coreReportsStuck, s.logs[id]?.entries ?? s.recent[id] ?? []);
  const stuckChip = stuck ? (
    <View style={{ marginTop: SPACE.s, gap: SPACE.s }}>
      <SlowEngine c={c} />
      <StuckChip
        reason={stuck}
        onNudge={() => {
          setNudging(true);
          setTab('talk');
        }}
      />
    </View>
  ) : (
    <View style={{ marginTop: SPACE.s }}>
      <SlowEngine c={c} />
    </View>
  );
  // On a phone the summary scrolls away with the content; on a wide screen it stays in its own column.
  const header = wide ? null : (
    <View>
      <Summary c={c} wide={false} onForget={() => setForgetOpen(true)} />
      {stuckChip}
      {tabs}
    </View>
  );
  const content =
    tab === 'activity' ? (
      <LogList log={s.logs[id]} name={c.name} onOlder={() => void store.loadOlder(id)} header={header} />
    ) : tab === 'sheet' ? (
      <SheetTab d={detail} header={header} />
    ) : tab === 'talk' ? (
      <>
        {wide ? null : (
          <View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s }}>
              <NameBlock c={c} />
            </View>
            {tabs}
          </View>
        )}
        <TalkTab
          // Remounts once the quests arrive, so the suggestion can name them (before the owner had time to type).
          key={nudging ? `nudge-${detail ? 'quests' : 'none'}` : 'talk'}
          id={id}
          name={c.name}
          initialCommand={nudging ? nudgeSuggestion(t, stuck, detail?.quests) : undefined}
        />
      </>
    ) : (
      <GuidanceTab id={id} d={detail} header={header} />
    );

  return (
    <Screen back fixed>
      {err ? <Notice tone="error">{err}</Notice> : null}
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: SPACE.m }}>
          <View style={{ width: 340 }}>
            <Summary c={c} wide onForget={() => setForgetOpen(true)} />
          </View>
          <View style={{ flex: 1, minHeight: 0 }}>
            {stuckChip}
            {tabs}
            <View style={{ flex: 1, minHeight: 0 }}>{content}</View>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, minHeight: 0 }}>{content}</View>
      )}
      <Confirm
        visible={forgetOpen}
        title={t('forget.title', { name: c.name })}
        body={t('forget.body', { name: c.name })}
        confirm={t('forget.confirm')}
        cancel={t('common.cancel')}
        onConfirm={() => void forget()}
        onCancel={() => setForgetOpen(false)}
        busy={forgetBusy}
      />
    </Screen>
  );
}
