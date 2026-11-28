import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import type { Core, EngineChoice, EngineState, EngineTest, ProviderInfo, ProviderKind } from '../core/types';
import { errorText, useI18n } from '../i18n/context';
import { formatBytes, formatNumber } from '../i18n/i18n';
import { useAppState, useStore, useWide } from '../state/hooks';
import { failureOf } from '../state/store';
import { verifyProgress } from '../state/verify';
import { Screen } from '../ui/chrome';
import { Bar, Body, Choice, Dot, Field, Heading, Notice, PixelBox, PixelButton } from '../ui/kit';
import { openExternal, safeHttpUrl } from '../ui/links';
import { C, FONT, SPACE } from '../ui/theme';

const DEFAULT_URL: Partial<Record<ProviderKind, string>> = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234' };

function useAct() {
  const i18n = useI18n();
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Runs an engine request; its answer is applied by the store unless a newer engine event already arrived. */
  const run = async (fn: (core: Core) => Promise<EngineState>) => {
    setBusy(true);
    setErr(null);
    try {
      await store.engineAction(fn);
    } catch (x) {
      setErr(errorText(i18n, failureOf(x)));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

function Current({ engine }: { engine: EngineState }) {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const store = useStore();
  const [test, setTest] = useState<EngineTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const runTest = async () => {
    if (!store.core) return;
    setTesting(true);
    setErr(null);
    setTest(null);
    try {
      setTest(await store.core.testEngine());
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setTesting(false);
    }
  };
  const label = engine.choice.kind === 'builtin' ? (engine.builtin?.model ?? t('engine.builtin')) : `${engine.choice.kind === 'openai' ? t('engine.custom') : engine.choice.kind === 'ollama' ? 'Ollama' : 'LM Studio'}${engine.choice.model ? ` · ${engine.choice.model}` : ''}`;
  const color = engine.status === 'ready' ? C.teal : engine.status === 'downloading' || engine.status === 'starting' ? C.amber : C.red;
  const pct = engine.builtin && engine.builtin.bytesTotal ? Math.floor((engine.builtin.bytesDone / engine.builtin.bytesTotal) * 100) : 0;
  return (
    <PixelBox edge={engine.status === 'ready' ? C.edge : C.amberDim} style={{ marginBottom: SPACE.m }}>
      <Heading level={2}>{t('engine.current')}</Heading>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s, flexWrap: 'wrap' }}>
        <Dot color={color} pulse={engine.status === 'starting' || engine.status === 'downloading'} />
        <Text style={{ color: C.text, fontWeight: '700', fontSize: 16, flexShrink: 1 }}>{label}</Text>
        <Text style={{ color, fontSize: 13 }}>{t(`engine.status.${engine.status}`, { percent: pct })}</Text>
      </View>
      {engine.message ? <Body muted style={{ fontSize: 13, marginTop: 4 }}>{i18n.has(`error.${engine.message}`) ? t(`error.${engine.message}`) : engine.message}</Body> : null}
      {engine.tokensPerSecond ? (
        <Text style={{ color: C.muted, marginTop: 4, fontFamily: FONT.mono }}>{t('engine.speed', { tps: formatNumber(lang, engine.tokensPerSecond, 1) })}</Text>
      ) : null}
      {engine.tokensPerSecond !== undefined && engine.tokensPerSecond < 5 && engine.tokensPerSecond > 0 ? <Notice tone="warn">{t('engine.slowWarning')}</Notice> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.m, marginTop: SPACE.s, flexWrap: 'wrap' }}>
        <PixelButton small label={testing ? t('engine.testing') : t('engine.test')} onPress={() => void runTest()} busy={testing} disabled={engine.status !== 'ready'} />
        {testing ? <ActivityIndicator color={C.amber} /> : null}
      </View>
      {test ? (
        <View role="status" style={{ marginTop: SPACE.s }}>
          <Notice tone={test.ok && test.validJson ? 'info' : 'warn'}>
            {test.ok
              ? t(test.validJson ? 'engine.testOk' : 'engine.testBad', { tps: formatNumber(lang, test.tokensPerSecond, 1) })
              : `${t('engine.testFailed')}${test.message ? ` ${test.message}` : ''}`}
          </Notice>
          {test.sample ? (
            <>
              <Text style={{ color: C.faint, fontSize: 12, marginTop: 4 }}>{t('engine.sample')}</Text>
              <Text selectable numberOfLines={6} style={{ color: C.muted, fontFamily: FONT.mono, fontSize: 12, backgroundColor: C.trough, padding: SPACE.s }}>
                {test.sample}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
      {err ? <Notice tone="error">{err}</Notice> : null}
    </PixelBox>
  );
}

function Builtin({ engine, label }: { engine: EngineState; label: string }) {
  const { t, lang } = useI18n();
  const { busy, err, run } = useAct();
  const b = engine.builtin;
  const inUse = engine.choice.kind === 'builtin';
  const total = b?.bytesTotal ?? 0;
  const done = b?.bytesDone ?? 0;
  const installed = total > 0 && done >= total;
  const downloading = inUse && engine.status === 'downloading';
  const paused = !downloading && !installed && done > 0;
  const pct = total ? Math.floor((done / total) * 100) : 0;
  const licence = safeHttpUrl(b?.licenseUrl);
  // Phone only: the downloaded file is being checked against its pinned SHA-256 (reported by the files adapter).
  const verifying = useSyncExternalStore(verifyProgress.subscribe, verifyProgress.get, verifyProgress.get);
  const verifyPct = verifying && verifying.bytesTotal ? Math.floor((verifying.bytesDone / verifying.bytesTotal) * 100) : 0;
  return (
    <PixelBox edge={inUse ? C.amber : C.edge} style={{ marginBottom: SPACE.s }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.s, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontWeight: '700', fontSize: 17, flexShrink: 1 }}>{b?.model ?? label}</Text>
        <Text style={{ color: C.ink, backgroundColor: C.amber, fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 2 }}>{t('engine.recommended')}</Text>
      </View>
      {b ? (
        <View style={{ marginTop: 4, gap: 2 }}>
          <Text style={{ color: C.muted, fontSize: 13 }}>{t('engine.size', { size: formatBytes(lang, total) })}</Text>
          <Text style={{ color: C.faint, fontSize: 12, fontFamily: FONT.mono }} numberOfLines={1}>
            {t('engine.file', { file: b.file })}
          </Text>
          {licence ? (
            <Text
              accessibilityRole="link"
              accessibilityHint={licence}
              onPress={() => void openExternal(licence)}
              style={{ color: C.teal, fontSize: 13, textDecorationLine: 'underline', alignSelf: 'flex-start' }}
            >
              {t('engine.license', { name: b.licenseName })} ↗
            </Text>
          ) : (
            <Text style={{ color: C.muted, fontSize: 13 }}>{t('engine.license', { name: b.licenseName })}</Text>
          )}
        </View>
      ) : null}
      {verifying ? (
        <View role="status" style={{ marginTop: SPACE.s }}>
          <Bar value={verifying.bytesDone} max={verifying.bytesTotal} color={C.teal} height={14} label={t('engine.verifying', { percent: verifyPct })} />
          <Text style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{t('engine.verifying', { percent: verifyPct })}</Text>
        </View>
      ) : null}
      {downloading || paused ? (
        <View style={{ marginTop: SPACE.s }}>
          <Bar value={done} max={total} color={C.amber} height={14} label={t('engine.progress', { done: formatBytes(lang, done), total: formatBytes(lang, total) })} />
          <Text style={{ color: C.muted, fontSize: 12, marginTop: 4, fontFamily: FONT.mono }}>
            {paused ? t('engine.pausedAt', { percent: pct }) : `${pct}% · ${t('engine.progress', { done: formatBytes(lang, done), total: formatBytes(lang, total) })}`}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: SPACE.s, alignItems: 'center' }}>
        {!inUse ? <PixelButton small kind="primary" label={t('engine.use')} busy={busy} onPress={() => void run((core) => core.setEngine({ kind: 'builtin' }))} /> : null}
        {inUse && !installed && !downloading ? (
          <PixelButton small kind="primary" label={paused ? t('engine.resume') : t('engine.download', { size: formatBytes(lang, total) })} busy={busy} onPress={() => void run((core) => core.startDownload())} />
        ) : null}
        {downloading ? <PixelButton small label={t('engine.pause')} busy={busy} onPress={() => void run((core) => core.pauseDownload())} /> : null}
        {downloading || paused ? <PixelButton small kind="danger" label={t('engine.cancel')} busy={busy} onPress={() => void run((core) => core.cancelDownload())} /> : null}
        {installed ? <Text style={{ color: C.teal, fontWeight: '700', marginLeft: SPACE.s }}>✓ {t('engine.installed')}</Text> : null}
        {inUse ? <Text style={{ color: C.amber, fontWeight: '700', marginLeft: SPACE.s }}>{t('engine.inUse')}</Text> : null}
      </View>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </PixelBox>
  );
}

function External({ p: probed, engine, hint }: { p: ProviderInfo; engine: EngineState; hint: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const store = useStore();
  const { busy, err, run } = useAct();
  // For the custom address: the result of probing what the owner typed (null until "Check").
  const [checked, setChecked] = useState<ProviderInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const p = checked ?? probed;
  const inUse = engine.choice.kind === p.kind;
  const custom = p.kind === 'openai';
  const [url, setUrl] = useState(inUse && engine.choice.url ? engine.choice.url : (p.url ?? DEFAULT_URL[p.kind] ?? ''));
  const [model, setModel] = useState<string>(inUse && engine.choice.model ? engine.choice.model : (p.models[0] ?? ''));
  const [apiKey, setApiKey] = useState('');
  const title = custom ? t('engine.custom') : p.label;
  const check = async () => {
    const target = url.trim().replace(/\/+$/, '');
    if (!store.core || !safeHttpUrl(target)) return;
    setChecking(true);
    setCheckErr(null);
    try {
      const found = await store.core.probeProvider(target);
      // The card keeps its own kind (an Ollama typed on the Ollama card stays Ollama).
      const info: ProviderInfo = { ...found, kind: probed.kind, url: target };
      setChecked(info);
      if (info.models.length > 0 && !info.models.includes(model)) setModel(info.models[0]!);
    } catch (e) {
      setCheckErr(errorText(i18n, failureOf(e)));
    } finally {
      setChecking(false);
    }
  };
  const use = () => {
    const choice: EngineChoice = { kind: p.kind, url: url.trim(), model: model.trim() || undefined };
    if (custom && apiKey.trim()) choice.apiKey = apiKey.trim();
    return run(async (core) => {
      const e = await core.setEngine(choice);
      setApiKey('');
      return e;
    });
  };
  return (
    <PixelBox edge={inUse ? C.amber : C.edge} style={{ marginBottom: SPACE.s }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.s, flexWrap: 'wrap' }}>
        <Text style={{ color: C.text, fontWeight: '700', fontSize: 17, flexShrink: 1 }}>{title}</Text>
        {!custom || checked ? (
          <View role={custom ? 'status' : undefined} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Dot color={p.reachable ? C.teal : C.faint} />
            <Text style={{ color: p.reachable ? C.teal : C.faint, fontSize: 13 }}>{p.reachable ? t('engine.found') : t('engine.notFound')}</Text>
          </View>
        ) : null}
      </View>
      <Body muted style={{ fontSize: 13, marginVertical: 4 }}>
        {hint}
      </Body>
      {/* Always editable: on a phone the usual address (127.0.0.1) is the phone itself, so the owner types the
          computer's address on the local network and checks it. */}
      <Field
        label={t('engine.address')}
        value={url}
        onChangeText={(v) => {
          setUrl(v);
          setChecked(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={DEFAULT_URL[p.kind] ?? 'http://127.0.0.1:8000'}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s, marginTop: -SPACE.s, marginBottom: SPACE.m }}>
        <PixelButton small label={checking ? t('engine.checking') : t('engine.check')} busy={checking} disabled={!safeHttpUrl(url.trim())} onPress={() => void check()} />
        {checking ? <ActivityIndicator color={C.amber} /> : null}
      </View>
      {checkErr ? <Notice tone="error">{checkErr}</Notice> : null}
      {custom && p.models.length > 0 ? (
        <View style={{ marginBottom: SPACE.m }}>
          <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('engine.model')}</Text>
          <Choice wrap label={t('engine.model')} options={p.models.map((m) => ({ value: m, label: m }))} value={model} onChange={setModel} />
          <Field label={t('engine.modelOther')} value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} style={{ marginTop: SPACE.s }} />
        </View>
      ) : p.models.length > 0 ? (
        <View style={{ marginBottom: SPACE.m }}>
          <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>{t('engine.model')}</Text>
          <Choice wrap label={t('engine.model')} options={p.models.map((m) => ({ value: m, label: m }))} value={model} onChange={setModel} />
        </View>
      ) : custom ? (
        <Field label={t('engine.model')} value={model} onChangeText={setModel} autoCapitalize="none" autoCorrect={false} />
      ) : p.reachable ? (
        <Notice tone="warn">{t('engine.noModels')}</Notice>
      ) : null}
      {custom ? (
        <Field
          label={t('engine.apiKey')}
          hint={inUse && engine.choice.hasApiKey ? t('engine.apiKeySaved') : undefined}
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.s, flexWrap: 'wrap' }}>
        <PixelButton
          small
          kind={inUse ? 'secondary' : 'primary'}
          label={t('engine.use')}
          busy={busy}
          disabled={!safeHttpUrl(url.trim())}
          onPress={() => void use()}
        />
        {inUse ? <Text style={{ color: C.amber, fontWeight: '700' }}>{t('engine.inUse')}</Text> : null}
        {inUse && engine.status === 'unreachable' ? <Text style={{ color: C.red, fontSize: 13 }}>{t('engine.status.unreachable')}</Text> : null}
      </View>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </PixelBox>
  );
}

export default function EngineScreen() {
  const i18n = useI18n();
  const { t } = i18n;
  const s = useAppState();
  const store = useStore();
  const wide = useWide();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const probe = useCallback(async () => {
    if (!store.core) return;
    setLoading(true);
    setErr(null);
    try {
      setProviders(await store.core.providers());
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setLoading(false);
    }
  }, [store, i18n]);
  useEffect(() => {
    // Probing the local servers when the screen opens is what this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (s.phase === 'ready') void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase]);
  const engine = s.core?.engine;
  const list = providers ?? [];
  const builtin = list.find((p) => p.kind === 'builtin');
  const hints: Record<string, string> = { ollama: t('engine.ollamaHint'), lmstudio: t('engine.lmstudioHint'), openai: t('engine.customHint') };
  const external = (['ollama', 'lmstudio', 'openai'] as const).map(
    (k) => list.find((p) => p.kind === k) ?? { kind: k, label: k === 'openai' ? t('engine.custom') : k === 'ollama' ? 'Ollama' : 'LM Studio', reachable: false, models: [] },
  );
  return (
    <Screen max={wide ? 1000 : 640}>
      <Heading level={1}>{t('engine.title')}</Heading>
      <Body muted style={{ marginBottom: SPACE.m }}>
        {t('engine.intro')}
      </Body>
      {store.kind === 'local' ? <Notice tone="warn">{t('error.not_available')}</Notice> : null}
      {engine ? (
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: SPACE.m, alignItems: 'flex-start' }}>
          <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : '100%' }}>
            <Current engine={engine} />
            {store.kind !== 'local' ? <Builtin engine={engine} label={builtin?.label ?? t('engine.builtin')} /> : null}
          </View>
          <View style={{ flex: wide ? 1 : undefined, width: wide ? undefined : '100%' }}>
            {providers || store.kind === 'local' ? null : (
              <View style={{ flexDirection: 'row', gap: SPACE.s, alignItems: 'center', padding: SPACE.s }}>
                <ActivityIndicator color={C.amber} />
                <Text style={{ color: C.muted }}>{t('engine.searching')}</Text>
              </View>
            )}
            {providers ? external.map((p) => <External key={`${p.kind}-${p.url ?? ''}-${p.models.join(',')}`} p={p} engine={engine} hint={hints[p.kind] ?? ''} />) : null}
            {providers ? <PixelButton small label={t('engine.refresh')} busy={loading} onPress={() => void probe()} /> : null}
            {err ? <Notice tone="error">{err}</Notice> : null}
          </View>
        </View>
      ) : (
        <Text style={{ color: C.muted }}>{t('common.loading')}</Text>
      )}
    </Screen>
  );
}
