import { useState } from 'react';
import { PixelRatio, View } from 'react-native';
import type { CharacterStatus } from '../core/types';
import { crispScale, frameBox, isDrawableSprite } from './sprite-math';
import { SpriteFallback } from './SpriteFallback';
import { useSpriteFrame } from './useSpriteFrame';

type Props = { uri: string | null; status: CharacterStatus; pixel: number; color: string; initial: string };

/** Web: a plain <img> with `image-rendering: pixelated`, shifted by whole frames inside a clipping box. */
export default function Sprite({ uri, status, pixel, color, initial }: Props) {
  const frame = useSpriteFrame(status);
  const [broken, setBroken] = useState(false);
  const { css } = crispScale(pixel, PixelRatio.get());
  const box = frameBox(frame, css);
  if (!isDrawableSprite(uri) || broken) return <SpriteFallback width={box.width} height={box.height} color={color} initial={initial} />;
  return (
    <View
      aria-hidden
      style={{ width: box.width, height: box.height, overflow: 'hidden', opacity: status === 'fallen' ? 0.5 : 1 }}
    >
      <img
        src={uri}
        alt=""
        draggable={false}
        onError={() => setBroken(true)}
        referrerPolicy="no-referrer"
        style={{
          display: 'block',
          width: box.sheetWidth,
          height: box.height,
          maxWidth: 'none',
          transform: `translateX(${box.offsetX}px)`,
          imageRendering: 'pixelated',
          filter: status === 'fallen' ? 'grayscale(1)' : undefined,
          userSelect: 'none',
        }}
      />
    </View>
  );
}
