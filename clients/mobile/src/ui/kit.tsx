/**
 * The building blocks: framed "pixel box" panels, pixel buttons, headings, fields and toggles in the web app's style.
 * No text lives here: every label is passed in already translated.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useReducedMotion } from '../state/hooks';
import { C, FONT, SPACE } from './theme';

/** Square panel with a stepped 2 px border and notched corners, like `.pixel-box` on the web. */
export function PixelBox({
  children,
  style,
  edge = C.edge,
  fill = C.panel,
  pad = SPACE.m,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  edge?: string;
  fill?: string;
  pad?: number;
}) {
  return (
    <View style={[{ margin: 2, borderWidth: 2, borderColor: edge, backgroundColor: fill, padding: pad }, style]}>
      {children}
      {/* notched corners */}
      <View pointerEvents="none" style={[corner, { top: -2, left: -2 }]} />
      <View pointerEvents="none" style={[corner, { top: -2, right: -2 }]} />
      <View pointerEvents="none" style={[corner, { bottom: -2, left: -2 }]} />
      <View pointerEvents="none" style={[corner, { bottom: -2, right: -2 }]} />
      {/* inner highlight */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.05)' }} />
    </View>
  );
}
const corner: ViewStyle = { position: 'absolute', width: 2, height: 2, backgroundColor: C.bg };

export function Heading({ children, style, level = 2 }: { children: ReactNode; style?: StyleProp<TextStyle>; level?: 1 | 2 | 3 }) {
  return (
    <Text
      role="heading"
      aria-level={level}
      style={[
        {
          color: level === 1 ? C.amber : C.muted,
          fontFamily: level === 1 ? FONT.serif : FONT.sans,
          fontSize: level === 1 ? 22 : 12,
          fontWeight: '700',
          letterSpacing: level === 1 ? 0.3 : 1.4,
          textTransform: level === 1 ? 'none' : 'uppercase',
          marginBottom: SPACE.s,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Body({ children, style, muted, selectable }: { children: ReactNode; style?: StyleProp<TextStyle>; muted?: boolean; selectable?: boolean }) {
  return (
    <Text selectable={selectable} style={[{ color: muted ? C.muted : C.text, fontFamily: FONT.sans, fontSize: 15, lineHeight: 21 }, style]}>
      {children}
    </Text>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';
const BTN: Record<ButtonKind, { bg: string; fg: string; edge: string }> = {
  primary: { bg: C.amber, fg: C.ink, edge: '#ffd98a' },
  secondary: { bg: C.panelHi, fg: C.text, edge: C.edge },
  danger: { bg: '#3a1c24', fg: '#ffb3ad', edge: C.red },
  ghost: { bg: 'transparent', fg: C.muted, edge: 'transparent' },
};

export function PixelButton({
  label,
  onPress,
  kind = 'secondary',
  disabled,
  busy,
  icon,
  a11yLabel,
  a11yHint,
  style,
  small,
}: {
  label: string;
  onPress?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
  icon?: string;
  a11yLabel?: string;
  a11yHint?: string;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const k = BTN[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityHint={a11yHint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        {
          margin: 2,
          minHeight: small ? 34 : 44,
          paddingHorizontal: small ? SPACE.m : SPACE.l,
          justifyContent: 'center',
          alignItems: 'center',
          flexDirection: 'row',
          gap: 6,
          backgroundColor: k.bg,
          borderWidth: kind === 'ghost' ? 0 : 2,
          borderColor: k.edge,
          borderBottomWidth: kind === 'ghost' ? 0 : pressed ? 2 : 4,
          transform: [{ translateY: pressed && !off ? 2 : 0 }],
          opacity: off ? 0.5 : hovered ? 0.92 : 1,
        },
        style,
      ]}
    >
      {icon ? <Text aria-hidden style={{ color: k.fg, fontSize: small ? 13 : 15 }}>{icon}</Text> : null}
      <Text style={{ color: k.fg, fontFamily: FONT.sans, fontWeight: '700', fontSize: small ? 13 : 15 }}>{label}</Text>
    </Pressable>
  );
}

/** A bar that fills smoothly (instantly with reduced motion), with a screen-reader value. */
export function Bar({
  value,
  max,
  color,
  label,
  text,
  height = 10,
  style,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
  text?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const [anim] = useState(() => new Animated.Value(ratio));
  useEffect(() => {
    if (reduced) {
      anim.setValue(ratio);
      return;
    }
    Animated.timing(anim, { toValue: ratio, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [ratio, reduced, anim]);
  const width = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View
      accessible
      role="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: Math.max(0, Math.round(max)), now: Math.max(0, Math.round(value)), text }}
      style={[{ height, backgroundColor: C.trough, borderWidth: 1, borderColor: C.edgeDark }, style]}
    >
      <Animated.View style={{ width, height: '100%', backgroundColor: color }}>
        <View style={{ height: Math.max(1, Math.floor(height / 4)), backgroundColor: 'rgba(255,255,255,0.28)' }} />
      </Animated.View>
    </View>
  );
}

/** A number that counts up or down to its new value, like an idle game's counters. */
export function useTicking(value: number, ms = 700): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = Date.now();
    const a = from.current;
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (Date.now() - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = Math.round(a + (value - a) * eased);
      setShown(v);
      from.current = v;
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms, reduced]);
  return shown;
}

export function Field({
  label,
  hint,
  error,
  style,
  bare,
  ...input
}: TextInputProps & { label: string; hint?: string; error?: string | null; bare?: boolean }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={[{ marginBottom: SPACE.m }, style as StyleProp<ViewStyle>]}>
      {bare ? null : <Text style={{ color: C.muted, fontSize: 13, fontWeight: '700', marginBottom: 4, fontFamily: FONT.sans }}>{label}</Text>}
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={C.faint}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        {...input}
        style={{
          color: C.text,
          backgroundColor: C.trough,
          borderWidth: 2,
          borderColor: error ? C.red : focus ? C.amber : C.edge,
          paddingHorizontal: SPACE.m,
          paddingVertical: 10,
          fontSize: 15,
          fontFamily: FONT.sans,
          minHeight: input.multiline ? 88 : 44,
          textAlignVertical: input.multiline ? 'top' : 'center',
          // web only: the focus colour above replaces the browser outline
          outlineStyle: 'none',
        } as unknown as TextStyle}
      />
      {error ? (
        <Text role="alert" style={{ color: C.red, fontSize: 13, marginTop: 4 }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ color: C.faint, fontSize: 13, marginTop: 4 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.m, paddingVertical: SPACE.s, marginBottom: SPACE.s }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: C.text, fontSize: 15, fontFamily: FONT.sans }}>{label}</Text>
        {hint ? <Text style={{ color: C.faint, fontSize: 13, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: C.edge, true: C.amberDim }}
        thumbColor={value ? C.amber : C.muted}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    </Pressable>
  );
}

/** A row of mutually exclusive choices. */
export function Choice<V extends string>({
  options,
  value,
  onChange,
  label,
  wrap,
  columns,
}: {
  options: { value: V; label: string; hint?: string; color?: string }[];
  value: V | null;
  onChange: (v: V) => void;
  label: string;
  wrap?: boolean;
  /** Lay the options out in a grid of this many columns. */
  columns?: number;
}) {
  return (
    <View role="radiogroup" aria-label={label} style={{ flexDirection: 'row', flexWrap: wrap || columns ? 'wrap' : 'nowrap', gap: 6 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={o.hint ? `${o.label}. ${o.hint}` : o.label}
            style={{
              flexGrow: wrap ? 0 : 1,
              flexBasis: columns ? `${Math.floor(100 / columns) - 3}%` : wrap ? undefined : 0,
              minHeight: 40,
              paddingHorizontal: SPACE.m,
              paddingVertical: 8,
              justifyContent: 'center',
              borderWidth: 2,
              borderColor: on ? (o.color ?? C.amber) : C.edge,
              backgroundColor: on ? C.panelHi : C.trough,
            }}
          >
            <Text style={{ color: on ? (o.color ?? C.amber) : C.text, fontWeight: '700', fontSize: 14, textAlign: 'center' }}>{o.label}</Text>
            {o.hint ? <Text style={{ color: C.faint, fontSize: 12, textAlign: 'center', marginTop: 2 }}>{o.hint}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  const reduced = useReducedMotion();
  const [a] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!pulse || reduced) {
      a.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        Animated.timing(a, { toValue: 1, duration: 600, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced, a]);
  return <Animated.View aria-hidden style={{ width: 8, height: 8, backgroundColor: color, opacity: a }} />;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' }) {
  const color = tone === 'error' ? C.red : tone === 'warn' ? C.amber : C.teal;
  return (
    <View role={tone === 'error' ? 'alert' : undefined} style={{ borderLeftWidth: 4, borderLeftColor: color, backgroundColor: C.trough, padding: SPACE.m, marginVertical: SPACE.s }}>
      {typeof children === 'string' ? <Body>{children}</Body> : children}
    </View>
  );
}
