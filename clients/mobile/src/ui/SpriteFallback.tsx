import { Text, View } from 'react-native';
import { C, FONT } from './theme';

/** Before the first sync (no sprite yet) or when the image fails: a framed initial in the class colour. */
export function SpriteFallback({ width, height, color, initial }: { width: number; height: number; color: string; initial: string }) {
  return (
    <View
      aria-hidden
      style={{
        width,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.edgeDark,
        borderWidth: 2,
        borderColor: color,
      }}
    >
      <Text style={{ color, fontFamily: FONT.serif, fontSize: Math.round(height / 2.6), fontWeight: '700' }}>{initial}</Text>
    </View>
  );
}
