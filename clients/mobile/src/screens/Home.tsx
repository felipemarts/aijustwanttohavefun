import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { errorText, useI18n } from '../i18n/context';
import { useAppState, useStore, useWide } from '../state/hooks';
import { AwayPanel, CharacterCard } from '../ui/character-bits';
import { Screen } from '../ui/chrome';
import { Body, Heading, Notice, PixelBox, PixelButton } from '../ui/kit';
import Sprite from '../ui/Sprite';
import { MOCK_SPRITES } from '../core/mock/sprites';
import { C, FONT, SPACE } from '../ui/theme';

function open(id: string) {
  router.push({ pathname: '/character', params: { id } });
}

/** Opens the character on Talk, in Command mode, with a suggested command to edit and send. */
function nudge(id: string) {
  router.push({ pathname: '/character', params: { id, tab: 'talk', nudge: '1' } });
}

function Empty() {
  const { t } = useI18n();
  const s = useAppState();
  const store = useStore();
  const engineReady = s.core?.engine.status === 'ready';
  const local = store.kind === 'local';
  return (
    <PixelBox style={{ alignItems: 'center', paddingVertical: SPACE.xl }}>
      <View style={{ flexDirection: 'row', gap: SPACE.l, marginBottom: SPACE.l, alignItems: 'flex-end' }}>
        {/* A placeholder adventurer, drawn from the game's own art for the demo; the fallback elsewhere. */}
        <Sprite uri={MOCK_SPRITES.nova} status="resting" pixel={4} color={C.amber} initial="?" />
      </View>
      <Heading level={1} style={{ textAlign: 'center' }}>
        {local ? t('home.local.title') : t('home.empty.title')}
      </Heading>
      <Body muted style={{ textAlign: 'center', maxWidth: 460, marginBottom: SPACE.l }}>
        {local ? t('home.local.body') : t('home.empty.body')}
      </Body>
      {local ? null : (
        <View style={{ gap: SPACE.s, width: '100%', maxWidth: 360 }}>
          <PixelButton
            kind={engineReady ? 'secondary' : 'primary'}
            label={engineReady ? t('home.empty.step1Done') : t('home.empty.step1')}
            icon={engineReady ? '✓' : undefined}
            onPress={() => router.navigate('/engine')}
          />
          <PixelButton kind={engineReady ? 'primary' : 'secondary'} label={t('home.empty.step2')} onPress={() => router.navigate('/new')} />
        </View>
      )}
    </PixelBox>
  );
}

export default function Home() {
  const i = useI18n();
  const { t } = i;
  const s = useAppState();
  const store = useStore();
  const wide = useWide();

  if (s.phase === 'loading') {
    return (
      <Screen>
        <Text accessibilityRole="progressbar" style={{ color: C.muted, padding: SPACE.l }}>
          {t('common.loading')}
        </Text>
      </Screen>
    );
  }
  if (s.phase === 'error') {
    return (
      <Screen max={640}>
        <PixelBox style={{ marginTop: SPACE.l }}>
          <Heading level={1}>{t('home.error.title')}</Heading>
          <Notice tone="error">{errorText(i, s.error ?? { code: 'unknown', message: '' })}</Notice>
          <PixelButton kind="primary" label={t('common.retry')} onPress={() => void store.load()} />
        </PixelBox>
      </Screen>
    );
  }

  const chars = s.characters;
  return (
    <Screen>
      {s.connection === 'unauthorized' ? <Notice tone="error">{t('error.unauthorized')}</Notice> : null}
      <AwayPanel characters={chars} onOpen={open} />
      {chars.length === 0 ? (
        <Empty />
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.s }}>
            <Text role="heading" aria-level={2} style={{ color: C.muted, fontFamily: FONT.sans, fontWeight: '700', fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase' }}>
              {t('nav.home')} · {chars.length}
            </Text>
            <PixelButton small kind="primary" label={`+ ${t('home.add')}`} a11yLabel={t('home.add')} onPress={() => router.navigate('/new')} />
          </View>
          <View style={{ flexDirection: wide ? 'row' : 'column', flexWrap: 'wrap', gap: SPACE.s }}>
            {chars.map((c) => (
              <View key={c.id} style={wide ? { width: '49.4%' } : undefined}>
                <CharacterCard c={c} celebration={s.celebrations[c.id]} recent={s.recent[c.id]} onOpen={() => open(c.id)} onNudge={() => nudge(c.id)} />
              </View>
            ))}
          </View>
        </>
      )}
    </Screen>
  );
}
