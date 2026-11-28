import Constants from 'expo-constants';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { errorText, useI18n } from '../i18n/context';
import { LANGUAGES, resolveLanguage } from '../i18n/i18n';
import { useAppState, useStore } from '../state/hooks';
import { failureOf } from '../state/store';
import { Screen } from '../ui/chrome';
import { Body, Choice, Field, Heading, Notice, PixelBox, PixelButton, Toggle } from '../ui/kit';
import { safeHttpUrl } from '../ui/links';
import { C, FONT, SPACE } from '../ui/theme';

export default function SettingsScreen() {
  const i18n = useI18n();
  const { t, lang } = i18n;
  const s = useAppState();
  const store = useStore();
  const settings = s.core?.settings;
  // null until the owner edits the field: until then it shows the core's value.
  const [edited, setServer] = useState<string | null>(null);
  const server = edited ?? settings?.serverUrl ?? '';
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = async (patch: Parameters<typeof store.setSettings>[0], mark = false) => {
    setBusy(true);
    setErr(null);
    try {
      await store.setSettings(patch);
      if (mark) setSaved(true);
    } catch (e) {
      setErr(errorText(i18n, failureOf(e)));
    } finally {
      setBusy(false);
    }
  };
  const serverValid = !!safeHttpUrl(server.trim());
  // Shown whenever the core reports the setting (desktop and phone); absent there means "on" by default.
  const showKeepAwake = settings ? 'keepAwake' in settings : false;
  const about = [
    t('settings.interfaceVersion', { version: Constants.expoConfig?.version ?? '?' }),
    s.core ? t('settings.coreVersion', { version: s.core.version }) : null,
    s.core ? t('settings.playkitVersion', { version: s.core.playkit }) : null,
    s.core ? t(`settings.platform.${s.core.platform}`) : null,
    s.core?.server.skillVersion ? t('settings.skillVersion', { version: s.core.server.skillVersion }) : null,
  ].filter(Boolean) as string[];

  return (
    <Screen max={640}>
      <Heading level={1}>{t('settings.title')}</Heading>
      {!settings ? (
        <Text style={{ color: C.muted }}>{t('common.loading')}</Text>
      ) : (
        <>
          <PixelBox style={{ marginBottom: SPACE.s }}>
            <Field
              label={t('settings.server')}
              hint={t('settings.serverHint')}
              value={server}
              onChangeText={(v) => {
                setServer(v);
                setSaved(false);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              error={server && !serverValid ? t('error.INVALID_URL') : null}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.m }}>
              <PixelButton
                kind="primary"
                label={t('common.save')}
                busy={busy}
                disabled={!serverValid || server.trim() === settings.serverUrl}
                onPress={() => void apply({ serverUrl: server.trim().replace(/\/+$/, '') }, true)}
              />
              {saved ? (
                <Text role="status" style={{ color: C.teal }}>
                  {t('common.saved')}
                </Text>
              ) : null}
            </View>
          </PixelBox>
          <PixelBox style={{ marginBottom: SPACE.s }}>
            <Heading level={2}>{t('settings.language')}</Heading>
            <Choice
              wrap
              label={t('settings.language')}
              options={LANGUAGES.map((l) => ({ value: l.tag, label: l.name }))}
              value={resolveLanguage(settings.language || lang)}
              onChange={(v) => void apply({ language: v })}
            />
            <Body muted style={{ fontSize: 13, marginTop: SPACE.s }}>
              {t('settings.languageNote')}
            </Body>
          </PixelBox>
          {showKeepAwake ? (
            <PixelBox style={{ marginBottom: SPACE.s }}>
              <Toggle
                label={t('settings.keepAwake')}
                hint={t('settings.keepAwakeHint')}
                value={settings.keepAwake !== false}
                onChange={(v) => void apply({ keepAwake: v })}
              />
            </PixelBox>
          ) : null}
          {err ? <Notice tone="error">{err}</Notice> : null}
        </>
      )}
      <PixelBox>
        <Heading level={2}>{t('settings.about')}</Heading>
        {about.map((line) => (
          <Text key={line} style={{ color: C.muted, fontFamily: FONT.mono, fontSize: 13, marginBottom: 2 }}>
            {line}
          </Text>
        ))}
        <Body muted style={{ fontSize: 13, marginTop: SPACE.s }}>
          {t('settings.license')}
        </Body>
      </PixelBox>
    </Screen>
  );
}
