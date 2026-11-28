/** The Sheet, Talk and Guidance tabs of the character screen. */
import { useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import type { CharacterDetail, ChatMessage, Directives } from '../core/types';
import { errorText, useI18n } from '../i18n/context';
import { formatNumber } from '../i18n/i18n';
import { useAppState, useStore, useWide } from '../state/hooks';
import { failureOf } from '../state/store';
import { Bar, Body, Choice, Field, Heading, Notice, PixelBox, PixelButton, Toggle } from './kit';
import { C, FONT, SPACE } from './theme';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <PixelBox style={{ marginBottom: SPACE.s }}>
      <Heading level={2}>{title}</Heading>
      {children}
    </PixelBox>
  );
}

function Nothing() {
  const { t } = useI18n();
  return <Body muted>{t('sheet.nothing')}</Body>;
}

export function SheetTab({ d, header }: { d: CharacterDetail | undefined; header?: React.ReactNode }) {
  const { t, lang } = useI18n();
  const wide = useWide();
  if (!d) {
    return (
      <ScrollView style={{ flex: 1 }}>
        {header}
        <Text style={{ color: C.muted, padding: SPACE.m }}>{t('common.loading')}</Text>
      </ScrollView>
    );
  }
  const equipped = d.inventory.filter((i) => i.slot);
  const bag = d.inventory.filter((i) => !i.slot);
  const col = wide ? ({ flex: 1, minWidth: 0 } as const) : ({ minWidth: 0 } as const);
  const left = (
    <View style={col}>
      {d.bio ? (
        <Section title={t('sheet.bio')}>
          <Body selectable>{d.bio}</Body>
        </Section>
      ) : null}
      <Section title={t('sheet.stats')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.s }}>
          {d.stats.map((st) => (
            <View key={st.id} style={{ minWidth: 92, flexGrow: 1, backgroundColor: C.trough, padding: SPACE.s, borderWidth: 1, borderColor: C.edgeDark }}>
              <Text style={{ color: C.faint, fontSize: 11, fontWeight: '700' }}>{st.name}</Text>
              <Text style={{ color: C.text, fontSize: 18, fontWeight: '700', fontFamily: FONT.mono }}>{formatNumber(lang, st.value)}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title={t('sheet.equipment')}>
        {equipped.length === 0 ? <Nothing /> : null}
        {equipped.map((i) => (
          <View key={i.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
            <Body>{i.name}</Body>
            <Text style={{ color: C.faint, fontSize: 12 }}>{i.slot?.name}</Text>
          </View>
        ))}
      </Section>
      <Section title={t('sheet.inventory')}>
        {bag.length === 0 ? <Nothing /> : null}
        {bag.map((i) => (
          <View key={i.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
            <Body>{i.name}</Body>
            <Text style={{ color: C.muted, fontFamily: FONT.mono }}>{t('sheet.qty', { qty: i.qty })}</Text>
          </View>
        ))}
      </Section>
    </View>
  );
  const right = (
    <View style={col}>
      <Section title={t('sheet.quests')}>
        {d.quests.length === 0 ? <Nothing /> : null}
        {d.quests.map((q) => (
          <View key={q.id} style={{ marginBottom: SPACE.m }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SPACE.s, flexWrap: 'wrap' }}>
              <Text style={{ color: C.text, fontWeight: '700' }}>{q.name}</Text>
              {q.ready ? <Text style={{ color: C.teal, fontSize: 12, fontWeight: '700' }}>{t('sheet.questReady')}</Text> : null}
            </View>
            {q.steps.map((st, j) => (
              <View key={j} style={{ marginTop: 4 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: C.muted, fontSize: 13, flexShrink: 1 }}>{st.text}</Text>
                  <Text style={{ color: C.muted, fontSize: 12, fontFamily: FONT.mono }}>{t('sheet.step', { have: st.have, need: st.need })}</Text>
                </View>
                <Bar value={st.have} max={st.need} color={st.have >= st.need ? C.teal : C.amber} height={8} label={`${st.text}: ${t('sheet.step', { have: st.have, need: st.need })}`} style={{ marginTop: 2 }} />
              </View>
            ))}
          </View>
        ))}
      </Section>
      <Section title={t('sheet.achievements')}>
        {d.achievements.length === 0 ? <Nothing /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {d.achievements.map((a, i) => (
            <Text key={`${a}-${i}`} style={{ color: C.amber, borderWidth: 1, borderColor: C.amberDim, paddingHorizontal: 8, paddingVertical: 2, fontSize: 13 }}>
              {a}
            </Text>
          ))}
        </View>
      </Section>
      <Section title={`${t('sheet.party')} · ${t('sheet.guild')}`}>
        <Body>{d.party ? d.party.members.join(', ') : t('sheet.noParty')}</Body>
        <Body style={{ marginTop: 4 }}>{d.guild ?? t('sheet.noGuild')}</Body>
      </Section>
      <Section title={t('sheet.memory')}>
        <Body muted style={{ fontSize: 13, marginBottom: 6 }}>
          {t('sheet.memoryNote')}
        </Body>
        {d.memory.length === 0 ? <Nothing /> : null}
        {d.memory.map((m, i) => (
          <Body key={i} selectable style={{ fontSize: 14, marginBottom: 4, fontFamily: FONT.serif }}>
            {'• '}
            {m}
          </Body>
        ))}
      </Section>
    </View>
  );
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: SPACE.s }}>
      {header}
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: SPACE.s, paddingTop: SPACE.s }}>
        {left}
        {right}
      </View>
    </ScrollView>
  );
}

function Bubble({ m, name }: { m: ChatMessage; name: string }) {
  const { t } = useI18n();
  const mine = m.from === 'owner';
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', marginBottom: SPACE.s }}>
      <Text style={{ color: C.faint, fontSize: 11, fontWeight: '700', marginBottom: 2, textAlign: mine ? 'right' : 'left' }}>{mine ? t('talk.you') : name}</Text>
      <View style={{ backgroundColor: mine ? C.panelHi : C.trough, borderWidth: 2, borderColor: mine ? C.edge : C.amberDim, padding: SPACE.s }}>
        <Text selectable style={{ color: C.text, fontSize: 15, lineHeight: 21, fontFamily: mine ? FONT.sans : FONT.serif }}>
          {m.text}
        </Text>
      </View>
    </View>
  );
}

/**
 * Talk: a conversation with the character (it answers, it does not act), or, in Command mode, something for it to do
 * on its next turns. A nudge from the "seems stuck" signal opens this in Command mode with a suggestion to edit.
 */
export function TalkTab({ id, name, initialCommand }: { id: string; name: string; initialCommand?: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const s = useAppState();
  const store = useStore();
  const [mode, setMode] = useState<'chat' | 'command'>(initialCommand ? 'command' : 'chat');
  const [text, setText] = useState(initialCommand ?? '');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const msgs = s.chats[id] ?? [];
  const stream = s.streams[id];
  const shown: ChatMessage[] = stream ? [...msgs, { id: stream.messageId, ts: 0, from: 'character', text: stream.text }] : msgs;
  useEffect(() => {
    const t1 = setTimeout(() => list.current?.scrollToEnd({ animated: true }), 30);
    return () => clearTimeout(t1);
  }, [shown.length, stream?.text]);
  const send = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    setSent(false);
    setText('');
    try {
      if (mode === 'command') {
        await store.core!.command(id, v);
        setSent(true);
      } else {
        await store.sendChat(id, v);
      }
    } catch (e) {
      setText(v);
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={list}
        data={shown}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <Bubble m={item} name={name} />}
        accessibilityLabel={t('talk.label', { name })}
        ListEmptyComponent={<Body muted style={{ textAlign: 'center', padding: SPACE.l }}>{t('talk.empty')}</Body>}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: SPACE.s }}
      />
      {busy && !stream ? (
        <Text role="status" style={{ color: C.muted, fontStyle: 'italic', paddingHorizontal: SPACE.s, paddingBottom: 4 }}>
          {t('talk.typing', { name })}
        </Text>
      ) : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
      {sent && mode === 'command' ? (
        <Text role="status" style={{ color: C.teal, paddingHorizontal: SPACE.s, paddingBottom: 4 }}>
          {t('guide.commandSent')}
        </Text>
      ) : null}
      <View style={{ paddingTop: SPACE.s }}>
        <Choice
          label={t('talk.modeLabel')}
          options={[
            { value: 'chat', label: t('talk.modeChat') },
            { value: 'command', label: t('talk.modeCommand') },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setSent(false);
          }}
        />
        {mode === 'command' ? <Text style={{ color: C.faint, fontSize: 12, marginTop: 4 }}>{t('talk.commandHint')}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.s, paddingTop: SPACE.s }}>
        <Field
          bare
          multiline={mode === 'command'}
          label={mode === 'command' ? t('talk.commandPlaceholder', { name }) : t('talk.placeholder', { name })}
          placeholder={mode === 'command' ? t('talk.commandPlaceholder', { name }) : t('talk.placeholder', { name })}
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => void send()}
          returnKeyType="send"
          maxLength={mode === 'command' ? 300 : 1000}
          style={{ flex: 1, marginBottom: 0 }}
        />
        <PixelButton kind="primary" label={t('talk.send')} onPress={() => void send()} disabled={!text.trim()} busy={busy} />
      </View>
    </KeyboardAvoidingView>
  );
}

export function GuidanceTab({ id, d, header }: { id: string; d: CharacterDetail | undefined; header?: React.ReactNode }) {
  const { t } = useI18n();
  if (!d) {
    return (
      <ScrollView style={{ flex: 1 }}>
        {header}
        <Text style={{ color: C.muted, padding: SPACE.m }}>{t('common.loading')}</Text>
      </ScrollView>
    );
  }
  return <GuidanceForm key={id} id={id} initial={d.directives} header={header} />;
}

function GuidanceForm({ id, initial, header }: { id: string; initial: Directives; header?: React.ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  const store = useStore();
  const [form, setForm] = useState<Directives>(initial);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [cmdState, setCmdState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const patch = (p: Partial<Directives>) => {
    setForm({ ...form, ...p });
    setSaved(false);
  };
  const save = async () => {
    if (!store.core) return;
    setBusy(true);
    setErr(null);
    try {
      setForm(await store.core.setDirectives(id, form));
      setSaved(true);
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setBusy(false);
    }
  };
  const sendCmd = async () => {
    const v = cmd.trim();
    if (!v || !store.core) return;
    setCmdState('busy');
    setErr(null);
    try {
      await store.core.command(id, v);
      setCmd('');
      setCmdState('sent');
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
      setCmdState('idle');
    }
  };
  const paces = (['relaxed', 'normal', 'active'] as const).map((p) => ({ value: p, label: t(`pace.${p}`), hint: t(`pace.${p}.desc`) }));
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: SPACE.s }} keyboardShouldPersistTaps="handled">
      {header}
      <PixelBox style={{ marginBottom: SPACE.s, marginTop: SPACE.s }}>
        <Field label={t('guide.persona')} hint={t('guide.personaHint')} value={form.persona} onChangeText={(v) => patch({ persona: v })} multiline maxLength={1000} />
        <Field label={t('guide.wish')} hint={t('guide.wishHint')} value={form.wish} onChangeText={(v) => patch({ wish: v })} maxLength={300} />
        <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('guide.pace')}</Text>
        <Choice label={t('guide.pace')} options={paces} value={form.pace} onChange={(v) => patch({ pace: v })} />
        <View style={{ height: SPACE.m }} />
        <Toggle label={t('guide.pvp')} hint={t('guide.pvpHint')} value={form.allowPvp} onChange={(v) => patch({ allowPvp: v })} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.m }}>
          <PixelButton kind="primary" label={t('common.save')} onPress={() => void save()} busy={busy} />
          {saved ? (
            <Text role="status" style={{ color: C.teal }}>
              {t('common.saved')}
            </Text>
          ) : null}
        </View>
      </PixelBox>
      <PixelBox>
        <Field label={t('guide.command')} hint={t('guide.commandHint')} value={cmd} onChangeText={(v) => { setCmd(v); setCmdState('idle'); }} maxLength={300} onSubmitEditing={() => void sendCmd()} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.m, flexWrap: 'wrap' }}>
          <PixelButton label={t('guide.commandSend')} onPress={() => void sendCmd()} busy={cmdState === 'busy'} disabled={!cmd.trim()} />
          {cmdState === 'sent' ? (
            <Text role="status" style={{ color: C.teal, flexShrink: 1 }}>
              {t('guide.commandSent')}
            </Text>
          ) : null}
        </View>
      </PixelBox>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </ScrollView>
  );
}
