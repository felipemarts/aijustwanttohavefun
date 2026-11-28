import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { AppearanceOptions, CharacterSummary, Directives, NewCharacter } from '../core/types';
import { errorText, useI18n } from '../i18n/context';
import { LANGUAGES, resolveLanguage } from '../i18n/i18n';
import { useAppState, useStore, useWide } from '../state/hooks';
import { failureOf } from '../state/store';
import { Screen } from '../ui/chrome';
import { Choice, Field, Heading, Notice, PixelBox, PixelButton, Toggle } from '../ui/kit';
import { C, CLASS_COLOR, SPACE } from '../ui/theme';

const CLASSES: CharacterSummary['class'][] = ['warrior', 'mage', 'rogue', 'cleric'];
const LAYER_ORDER = ['species', 'skin', 'hair_style', 'hair_color', 'hat', 'top', 'bottom', 'cloak', 'accessory', 'dye'];
const NAME_RE = /^[\p{L}\p{N}_-]{3,20}$/u;

export default function NewCharacterScreen() {
  const i18n = useI18n();
  const { t, has, lang } = i18n;
  const s = useAppState();
  const store = useStore();
  const wide = useWide();
  const [name, setName] = useState('');
  const [cls, setCls] = useState<CharacterSummary['class'] | null>(null);
  // null until the owner picks: until then it follows the interface language (known only once the core answered).
  const [picked, setLanguage] = useState<string | null>(null);
  const language = picked ?? resolveLanguage(lang);
  const [persona, setPersona] = useState('');
  const [bio, setBio] = useState('');
  const [wish, setWish] = useState('');
  const [pace, setPace] = useState<Directives['pace']>('normal');
  const [allowPvp, setAllowPvp] = useState(false);
  const [mode, setMode] = useState<'surprise' | 'pick'>('surprise');
  const [options, setOptions] = useState<AppearanceOptions | null>(null);
  const [optionsAt, setOptionsAt] = useState(0);
  const [optionsErr, setOptionsErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const loadOptions = useCallback(async () => {
    if (!store.core) return;
    setOptionsErr(null);
    try {
      const o = await store.core.appearanceOptions();
      setOptions(o);
      setOptionsAt(Date.now());
      // Preselect the first option of every layer so "create" works with any subset of picks.
      setChoice(Object.fromEntries(Object.entries(o.options).map(([layer, opts]) => [layer, Object.keys(opts)[0] ?? ''])));
    } catch (e) {
      setOptionsErr(errorText(i18n, failureOf(e)));
    }
  }, [store, i18n]);

  useEffect(() => {
    // Fetching on demand is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode === 'pick' && !options) void loadOptions();
  }, [mode, options, loadOptions]);

  const nameOk = NAME_RE.test(name.trim());

  const create = async () => {
    setTouched(true);
    if (!store.core || !nameOk || !cls) return;
    let appearance: NewCharacter['appearance'] = 'surprise_me';
    if (mode === 'pick' && options) {
      if (Date.now() - optionsAt > Math.max(0, options.expiresIn - 30) * 1000) {
        await loadOptions();
        return;
      }
      appearance = { optionsToken: options.optionsToken, choice };
    }
    setBusy(true);
    setErr(null);
    try {
      const c = await store.core.createCharacter({
        name: name.trim(),
        class: cls,
        language,
        persona: persona.trim(),
        bio: bio.trim() || undefined,
        wish: wish.trim() || undefined,
        pace,
        allowPvp,
        appearance,
      });
      store.dispatch({ t: 'character', character: c, now: Date.now() });
      // The owner pressed "Create": in an idle game that means "go and play". The core creates it paused.
      if (c.status === 'paused') await store.control(c.id, true).catch(() => {});
      router.replace({ pathname: '/character', params: { id: c.id } });
    } catch (e) {
      const f = failureOf(e);
      setErr(errorText(i18n, f));
      // The options token ran out between loading and creating: fetch fresh options to pick from again.
      if (f.code === 'OPTIONS_EXPIRED') void loadOptions();
    } finally {
      setBusy(false);
    }
  };

  const layers = options ? [...LAYER_ORDER.filter((l) => l in options.options), ...Object.keys(options.options).filter((l) => !LAYER_ORDER.includes(l))] : [];
  const engineReady = s.core?.engine.status === 'ready';

  return (
    <Screen back max={wide ? 900 : 640}>
      <Heading level={1}>{t('new.title')}</Heading>
      {!engineReady && s.core ? <Notice tone="warn">{t('new.noEngine')}</Notice> : null}
      <PixelBox style={{ marginBottom: SPACE.s }}>
        <Field
          label={t('new.name')}
          hint={t('new.nameHint')}
          value={name}
          onChangeText={setName}
          maxLength={20}
          autoCapitalize="words"
          autoCorrect={false}
          error={touched && !nameOk ? t('new.nameRequired') : null}
        />
        <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('new.class')}</Text>
        <Choice
          columns={wide ? 4 : 2}
          label={t('new.class')}
          options={CLASSES.map((k) => ({ value: k, label: t(`class.${k}`), hint: t(`class.${k}.desc`), color: CLASS_COLOR[k] }))}
          value={cls}
          onChange={setCls}
        />
        <View style={{ height: SPACE.m }} />
        {touched && !cls ? (
          <Text role="alert" style={{ color: C.red, fontSize: 13, marginTop: -SPACE.s, marginBottom: SPACE.s }}>
            {t('new.classRequired')}
          </Text>
        ) : null}
        <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('new.language')}</Text>
        <Choice wrap label={t('new.language')} options={LANGUAGES.map((l) => ({ value: l.tag, label: l.name }))} value={language} onChange={setLanguage} />
        <Text style={{ color: C.faint, fontSize: 13, marginTop: 4 }}>{t('new.languageHint')}</Text>
        <View style={{ height: SPACE.m }} />
        <Field label={t('new.persona')} hint={t('new.personaHint')} placeholder={t('new.personaPlaceholder')} value={persona} onChangeText={setPersona} multiline maxLength={1000} />
        <Field
          label={t('new.bio')}
          hint={`${t('new.bioHint')} ${t('new.bioCount', { n: bio.length })}`}
          placeholder={t('new.bioPlaceholder')}
          value={bio}
          onChangeText={setBio}
          multiline
          maxLength={300}
        />
      </PixelBox>
      <PixelBox style={{ marginBottom: SPACE.s }}>
        <Heading level={2}>{t('tab.guidance')}</Heading>
        <Field label={t('guide.wish')} hint={t('guide.wishHint')} value={wish} onChangeText={setWish} maxLength={300} />
        <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('guide.pace')}</Text>
        <Choice
          label={t('guide.pace')}
          options={(['relaxed', 'normal', 'active'] as const).map((p) => ({ value: p, label: t(`pace.${p}`), hint: t(`pace.${p}.desc`) }))}
          value={pace}
          onChange={setPace}
        />
        <View style={{ height: SPACE.m }} />
        <Toggle label={t('guide.pvp')} hint={t('guide.pvpHint')} value={allowPvp} onChange={setAllowPvp} />
      </PixelBox>
      <PixelBox style={{ marginBottom: SPACE.s }}>
        <Heading level={2}>{t('new.appearance')}</Heading>
        <Choice
          label={t('new.appearance')}
          options={[
            { value: 'surprise', label: t('new.surprise') },
            { value: 'pick', label: t('new.pick') },
          ]}
          value={mode}
          onChange={setMode}
        />
        {mode === 'pick' ? (
          <View style={{ marginTop: SPACE.m }}>
            {optionsErr ? (
              <>
                <Notice tone="error">{`${t('new.optionsFailed')} ${optionsErr}`}</Notice>
                <PixelButton small label={t('common.retry')} onPress={() => void loadOptions()} />
              </>
            ) : !options ? (
              <Text style={{ color: C.muted }}>{t('common.loading')}</Text>
            ) : (
              layers.map((layer) => (
                <View key={layer} style={{ marginBottom: SPACE.m }}>
                  <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{has(`layer.${layer}`) ? t(`layer.${layer}`) : layer}</Text>
                  <Choice
                    wrap
                    label={has(`layer.${layer}`) ? t(`layer.${layer}`) : layer}
                    options={Object.entries(options.options[layer] ?? {}).map(([id, desc]) => ({ value: id, label: desc }))}
                    value={choice[layer] ?? null}
                    onChange={(v) => setChoice({ ...choice, [layer]: v })}
                  />
                </View>
              ))
            )}
          </View>
        ) : null}
      </PixelBox>
      {err ? <Notice tone="error">{err}</Notice> : null}
      <PixelButton kind="primary" label={busy ? t('new.creating') : t('new.create')} busy={busy} onPress={() => void create()} />
    </Screen>
  );
}
