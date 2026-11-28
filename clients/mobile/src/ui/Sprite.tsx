import { useState } from 'react';
import { Image, PixelRatio, View } from 'react-native';
import type { CharacterStatus } from '../core/types';
import { crispScale, frameBox, isDrawableSprite } from './sprite-math';
import { SpriteFallback } from './SpriteFallback';
import { useSpriteFrame } from './useSpriteFrame';

type Props = { uri: string | null; status: CharacterStatus; pixel: number; color: string; initial: string };

/**
 * Native: the sheet in an Image shifted inside a clipping View. NOTE (unverified, see the report): React Native's
 * Image filters when it scales on Android and iOS, so pixels may look soft; a nearest-neighbour path (pre-scaled
 * PNGs from the server, or a Skia canvas) is left for the native build.
 */
export default function Sprite({ uri, status, pixel, color, initial }: Props) {
  const frame = useSpriteFrame(status);
  const [broken, setBroken] = useState(false);
  const { css } = crispScale(pixel, PixelRatio.get());
  const box = frameBox(frame, css);
  if (!isDrawableSprite(uri) || broken) return <SpriteFallback width={box.width} height={box.height} color={color} initial={initial} />;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: box.width, height: box.height, overflow: 'hidden', opacity: status === 'fallen' ? 0.5 : 1 }}
    >
      <Image
        source={{ uri }}
        onError={() => setBroken(true)}
        resizeMode="stretch"
        style={{ width: box.sheetWidth, height: box.height, transform: [{ translateX: box.offsetX }] }}
      />
    </View>
  );
}
