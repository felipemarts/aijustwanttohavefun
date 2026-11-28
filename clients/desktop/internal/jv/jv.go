// Package jv is a small JSON value model that keeps the order of object members, rejects duplicate keys, and
// writes JSON in the exact form the playkit specifies (see clients/playkit/README.md, "Text rules"). Order matters
// twice: constrained decoders emit properties in schema order, and prompts must be byte-identical across the Go and
// TypeScript cores.
package jv

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

type Kind uint8

const (
	Null Kind = iota
	Bool
	Number
	String
	Array
	Object
)

// Value is one JSON value. Objects keep their members in order.
type Value struct {
	Kind Kind
	B    bool
	N    float64
	S    string
	A    []Value
	O    []Member
}

type Member struct {
	Key string
	Val Value
}

func NullV() Value            { return Value{Kind: Null} }
func BoolV(b bool) Value      { return Value{Kind: Bool, B: b} }
func Num(n float64) Value     { return Value{Kind: Number, N: n} }
func Int(n int) Value         { return Value{Kind: Number, N: float64(n)} }
func Str(s string) Value      { return Value{Kind: String, S: s} }
func Arr(items ...Value) Value { return Value{Kind: Array, A: append([]Value{}, items...)} }

// Obj builds an object from alternating key, value pairs: Obj("a", Int(1), "b", Str("x")).
func Obj(kv ...any) Value {
	o := Value{Kind: Object, O: []Member{}}
	for i := 0; i+1 < len(kv); i += 2 {
		o.O = append(o.O, Member{Key: kv[i].(string), Val: kv[i+1].(Value)})
	}
	return o
}

func StrArr(ss []string) Value {
	a := Value{Kind: Array, A: make([]Value, 0, len(ss))}
	for _, s := range ss {
		a.A = append(a.A, Str(s))
	}
	return a
}

// Get returns the member named key of an object.
func (v Value) Get(key string) (Value, bool) {
	if v.Kind != Object {
		return Value{}, false
	}
	for _, m := range v.O {
		if m.Key == key {
			return m.Val, true
		}
	}
	return Value{}, false
}

// Has reports whether an object has the member key.
func (v Value) Has(key string) bool { _, ok := v.Get(key); return ok }

// Set replaces the member key, or appends it.
func (v *Value) Set(key string, val Value) {
	for i := range v.O {
		if v.O[i].Key == key {
			v.O[i].Val = val
			return
		}
	}
	v.O = append(v.O, Member{Key: key, Val: val})
}

// Delete removes the member key.
func (v *Value) Delete(key string) {
	out := v.O[:0]
	for _, m := range v.O {
		if m.Key != key {
			out = append(out, m)
		}
	}
	v.O = out
}

// Clone deep-copies a value.
func (v Value) Clone() Value {
	c := v
	if v.A != nil {
		c.A = make([]Value, len(v.A))
		for i, x := range v.A {
			c.A[i] = x.Clone()
		}
	}
	if v.O != nil {
		c.O = make([]Member, len(v.O))
		for i, m := range v.O {
			c.O[i] = Member{Key: m.Key, Val: m.Val.Clone()}
		}
	}
	return c
}

// Str returns the string, or "" for other kinds.
func (v Value) Text() string {
	if v.Kind == String {
		return v.S
	}
	return ""
}

// IsInt reports whether a number is integral.
func (v Value) IsInt() bool { return v.Kind == Number && v.N == math.Trunc(v.N) && !math.IsInf(v.N, 0) }

// Equal compares two values; object member order is significant.
func Equal(a, b Value) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case Null:
		return true
	case Bool:
		return a.B == b.B
	case Number:
		return a.N == b.N
	case String:
		return a.S == b.S
	case Array:
		if len(a.A) != len(b.A) {
			return false
		}
		for i := range a.A {
			if !Equal(a.A[i], b.A[i]) {
				return false
			}
		}
		return true
	default:
		if len(a.O) != len(b.O) {
			return false
		}
		for i := range a.O {
			if a.O[i].Key != b.O[i].Key || !Equal(a.O[i].Val, b.O[i].Val) {
				return false
			}
		}
		return true
	}
}

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────

// ErrDuplicateKey is returned when an object names the same key twice.
var ErrDuplicateKey = errors.New("duplicate key")

const maxDepth = 64

// Parse reads exactly one JSON value (surrounding whitespace allowed). Strict RFC 8259, ordered objects, duplicate
// keys refused, nesting limited to 64 levels.
func Parse(data string) (Value, error) {
	p := parser{s: data}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return Value{}, err
	}
	p.ws()
	if p.i != len(p.s) {
		return Value{}, p.errf("trailing data")
	}
	return v, nil
}

// ParseBytes is Parse for a byte slice.
func ParseBytes(b []byte) (Value, error) { return Parse(string(b)) }

type parser struct {
	s string
	i int
}

func (p *parser) errf(format string, a ...any) error {
	return fmt.Errorf("json at %d: %s", p.i, fmt.Sprintf(format, a...))
}

func (p *parser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *parser) value(depth int) (Value, error) {
	if depth > maxDepth {
		return Value{}, p.errf("too deep")
	}
	if p.i >= len(p.s) {
		return Value{}, p.errf("unexpected end")
	}
	switch c := p.s[p.i]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		s, err := p.str()
		return Str(s), err
	case c == 't':
		return p.lit("true", BoolV(true))
	case c == 'f':
		return p.lit("false", BoolV(false))
	case c == 'n':
		return p.lit("null", NullV())
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	default:
		return Value{}, p.errf("unexpected %q", c)
	}
}

func (p *parser) lit(word string, v Value) (Value, error) {
	if strings.HasPrefix(p.s[p.i:], word) {
		p.i += len(word)
		return v, nil
	}
	return Value{}, p.errf("bad literal")
}

func (p *parser) number() (Value, error) {
	start := p.i
	if p.s[p.i] == '-' {
		p.i++
	}
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return Value{}, p.errf("bad number")
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return Value{}, p.errf("bad number")
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return Value{}, p.errf("bad number")
		}
	}
	f, err := strconv.ParseFloat(p.s[start:p.i], 64)
	if err != nil || math.IsInf(f, 0) {
		return Value{}, p.errf("bad number")
	}
	return Num(f), nil
}

func hexv(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (p *parser) hex4() (rune, error) {
	if p.i+4 > len(p.s) {
		return 0, p.errf("bad escape")
	}
	r := 0
	for k := 0; k < 4; k++ {
		h := hexv(p.s[p.i+k])
		if h < 0 {
			return 0, p.errf("bad escape")
		}
		r = r<<4 | h
	}
	p.i += 4
	return rune(r), nil
}

// str reads a string. Lone surrogates and invalid UTF-8 become U+FFFD, as a JavaScript engine would show them.
func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var b strings.Builder
	for {
		if p.i >= len(p.s) {
			return "", p.errf("unterminated string")
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return b.String(), nil
		case c == '\\':
			p.i++
			if p.i >= len(p.s) {
				return "", p.errf("bad escape")
			}
			e := p.s[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				b.WriteByte(e)
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'u':
				r, err := p.hex4()
				if err != nil {
					return "", err
				}
				if utf16.IsSurrogate(r) {
					if r < 0xDC00 && strings.HasPrefix(p.s[p.i:], `\u`) {
						save := p.i
						p.i += 2
						r2, err := p.hex4()
						if err == nil && r2 >= 0xDC00 && r2 <= 0xDFFF {
							b.WriteRune(utf16.DecodeRune(r, r2))
							continue
						}
						p.i = save
					}
					r = utf8.RuneError
				}
				b.WriteRune(r)
			default:
				return "", p.errf("bad escape")
			}
		case c < 0x20:
			return "", p.errf("control character in string")
		default:
			r, size := utf8.DecodeRuneInString(p.s[p.i:])
			b.WriteRune(r) // RuneError for invalid bytes
			p.i += size
		}
	}
}

func (p *parser) array(depth int) (Value, error) {
	p.i++
	v := Value{Kind: Array, A: []Value{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		x, err := p.value(depth + 1)
		if err != nil {
			return Value{}, err
		}
		v.A = append(v.A, x)
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, p.errf("unexpected end")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == ']' {
			p.i++
			return v, nil
		}
		return Value{}, p.errf("expected , or ]")
	}
}

func (p *parser) object(depth int) (Value, error) {
	p.i++
	v := Value{Kind: Object, O: []Member{}}
	seen := map[string]bool{}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return Value{}, p.errf("expected key")
		}
		k, err := p.str()
		if err != nil {
			return Value{}, err
		}
		if seen[k] {
			return Value{}, fmt.Errorf("%w %q", ErrDuplicateKey, k)
		}
		seen[k] = true
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return Value{}, p.errf("expected :")
		}
		p.i++
		p.ws()
		x, err := p.value(depth + 1)
		if err != nil {
			return Value{}, err
		}
		v.O = append(v.O, Member{Key: k, Val: x})
		p.ws()
		if p.i >= len(p.s) {
			return Value{}, p.errf("unexpected end")
		}
		if p.s[p.i] == ',' {
			p.i++
			continue
		}
		if p.s[p.i] == '}' {
			p.i++
			return v, nil
		}
		return Value{}, p.errf("expected , or }")
	}
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────────────

// Quote writes s as a JSON string literal by the playkit rule: escape `"` `\`, \n \r \t as such, other code points
// below U+0020 and U+007F as \u00xx (lower-case hex), `<` and `>` as < and > (so quoted text can never form
// a delimiter tag), U+2028 and U+2029 as   and  . Everything else is written as is. Invalid UTF-8 is
// written as U+FFFD.
func Quote(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f || r == '<' || r == '>' || r == 0x2028 || r == 0x2029:
			fmt.Fprintf(&b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// FormatNumber writes integers in [-(2^53), 2^53] without fraction or exponent, and other numbers as the shortest
// decimal that reads back to the same float64, without exponent when 1e-6 <= |x| < 1e21 (JavaScript's rule).
func FormatNumber(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) <= 1<<53 {
		if f == 0 {
			return "0"
		}
		return strconv.FormatFloat(f, 'f', 0, 64)
	}
	a := math.Abs(f)
	if a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	// Exponent form as JavaScript writes it: 1.5e+21, 1e-7.
	s := strconv.FormatFloat(f, 'e', -1, 64)
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	if exp == "" {
		exp = "0"
	}
	return mant + "e" + string(sign) + exp
}

// Write serialises compactly, keeping member order.
func Write(v Value) string {
	var b strings.Builder
	write(&b, v, false)
	return b.String()
}

// Canon serialises compactly with object keys sorted by UTF-16 code units (JavaScript's default sort order).
func Canon(v Value) string {
	var b strings.Builder
	write(&b, v, true)
	return b.String()
}

func write(b *strings.Builder, v Value, sorted bool) {
	switch v.Kind {
	case Null:
		b.WriteString("null")
	case Bool:
		if v.B {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case Number:
		b.WriteString(FormatNumber(v.N))
	case String:
		b.WriteString(Quote(v.S))
	case Array:
		b.WriteByte('[')
		for i, x := range v.A {
			if i > 0 {
				b.WriteByte(',')
			}
			write(b, x, sorted)
		}
		b.WriteByte(']')
	case Object:
		members := v.O
		if sorted {
			members = append([]Member(nil), v.O...)
			sort.SliceStable(members, func(i, j int) bool { return LessUTF16(members[i].Key, members[j].Key) })
		}
		b.WriteByte('{')
		for i, m := range members {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(Quote(m.Key))
			b.WriteByte(':')
			write(b, m.Val, sorted)
		}
		b.WriteByte('}')
	}
}

// LessUTF16 compares two strings by UTF-16 code units, as JavaScript's default sort does.
func LessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// FromAny converts a value decoded by encoding/json (map keys sorted, since Go maps have no order).
func FromAny(x any) Value {
	switch t := x.(type) {
	case nil:
		return NullV()
	case bool:
		return BoolV(t)
	case float64:
		return Num(t)
	case int:
		return Int(t)
	case int64:
		return Num(float64(t))
	case string:
		return Str(t)
	case []any:
		a := Value{Kind: Array, A: make([]Value, 0, len(t))}
		for _, e := range t {
			a.A = append(a.A, FromAny(e))
		}
		return a
	case []string:
		return StrArr(t)
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return LessUTF16(keys[i], keys[j]) })
		o := Value{Kind: Object, O: make([]Member, 0, len(t))}
		for _, k := range keys {
			o.O = append(o.O, Member{Key: k, Val: FromAny(t[k])})
		}
		return o
	case Value:
		return t
	}
	return NullV()
}

// ToAny converts to plain Go values (objects become map[string]any and lose their order).
func ToAny(v Value) any {
	switch v.Kind {
	case Null:
		return nil
	case Bool:
		return v.B
	case Number:
		return v.N
	case String:
		return v.S
	case Array:
		out := make([]any, len(v.A))
		for i, x := range v.A {
			out[i] = ToAny(x)
		}
		return out
	default:
		out := make(map[string]any, len(v.O))
		for _, m := range v.O {
			out[m.Key] = ToAny(m.Val)
		}
		return out
	}
}

// MarshalJSON writes the value keeping member order (with Go's own string escaping, for transport only).
func (v Value) MarshalJSON() ([]byte, error) { return []byte(Write(v)), nil }

// UnmarshalJSON reads with Parse.
func (v *Value) UnmarshalJSON(b []byte) error {
	x, err := ParseBytes(b)
	if err != nil {
		return err
	}
	*v = x
	return nil
}
