import { useI18n } from '../i18n/context';
import { Screen } from '../ui/chrome';
import { Body, Heading, PixelBox } from '../ui/kit';
import { SPACE } from '../ui/theme';

/** Shown on every route when the page was opened without the desktop program's one-time key. */
export default function NoSession() {
  const { t } = useI18n();
  return (
    <Screen max={640}>
      <PixelBox style={{ marginTop: SPACE.xl }}>
        <Heading level={1}>{t('home.noSession.title')}</Heading>
        <Body>{t('home.noSession.body')}</Body>
      </PixelBox>
    </Screen>
  );
}
