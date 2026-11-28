import { useKeepAwake } from 'expo-keep-awake';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BOOT } from '../core/boot';
import { I18nProvider } from '../i18n/context';
import { StoreContext, useAppState } from '../state/hooks';
import { Store } from '../state/store';
import NoSession from '../screens/NoSession';
import { C } from '../ui/theme';

function deviceLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  } catch {
    return 'en';
  }
}

function KeepAwake() {
  useKeepAwake();
  return null;
}

function Shell() {
  const s = useAppState();
  // Opened without a valid key (no fragment and no session cookie), or the session ended: one message on every route.
  const noSession =
    s.connection === 'unauthorized' || (s.phase === 'error' && (s.error?.code === 'unauthorized' || s.error?.code === 'no_session'));
  const language = s.core?.settings.language || deviceLanguage();
  // On a phone the app keeps the screen on while a character is set to play (absent setting = on). On desktop the
  // Go program keeps the computer awake itself, so the web page does nothing.
  const keepAwake = Platform.OS !== 'web' && s.core?.settings.keepAwake !== false && s.characters.some((c) => c.status !== 'paused');
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') document.documentElement.lang = language;
  }, [language]);
  return (
    <I18nProvider language={language}>
      <StatusBar style="light" />
      {keepAwake ? <KeepAwake /> : null}
      {noSession ? (
        <NoSession />
      ) : (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'fade' }} />
      )}
    </I18nProvider>
  );
}

export default function RootLayout() {
  const [store] = useState(() => new Store(BOOT));
  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <SafeAreaProvider style={{ backgroundColor: C.bg }}>
        <Shell />
      </SafeAreaProvider>
    </StoreContext.Provider>
  );
}
