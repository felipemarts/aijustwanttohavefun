package playkit

import (
	"strings"
	"unicode/utf8"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// isSpace is the playkit's whitespace set: U+0009..U+000D, U+0020, U+0085, U+00A0, U+2028, U+2029.
func isSpace(r rune) bool {
	return (r >= 0x09 && r <= 0x0d) || r == 0x20 || r == 0x85 || r == 0xa0 || r == 0x2028 || r == 0x2029
}

// OneLine replaces every run of whitespace with one space and trims both ends. Invalid UTF-8 becomes U+FFFD.
func OneLine(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if isSpace(r) {
			space = true
			continue
		}
		if space && b.Len() > 0 {
			b.WriteByte(' ')
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// Clip keeps at most n code points: a longer string is cut to n-1 code points followed by "…" (U+2026).
func Clip(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	var b strings.Builder
	i := 0
	for _, r := range s {
		if i == n-1 {
			break
		}
		b.WriteRune(r)
		i++
	}
	b.WriteRune('…')
	return b.String()
}

// Plain is how text from the game or the owner that is not quoted enters a prompt: OneLine, every `<` and `>`
// removed (so it can never open or close a <chat> block), then Clip to n.
func Plain(s string, n int) string {
	s = OneLine(s)
	if strings.ContainsAny(s, "<>") {
		s = strings.NewReplacer("<", "", ">", "").Replace(s)
		s = OneLine(s)
	}
	return Clip(s, n)
}

// Quoted is how text written by another player's agent enters a prompt: OneLine, Clip to n, then jv.Quote.
func Quoted(s string, n int) string { return jv.Quote(Clip(OneLine(s), n)) }

// Render fills a template: every `{{name}}` (name of a-z and _) is replaced by its value in one left-to-right pass
// (values are not scanned again); unknown names are left as they are. Then the lines are tidied: a run of empty
// lines becomes one, and empty lines at the start and at the end are removed. Templates are read with CRLF turned
// into LF and their final newline removed.
func Render(tpl string, vals map[string]string) string {
	tpl = strings.TrimSuffix(tpl, "\n")
	var b strings.Builder
	for i := 0; i < len(tpl); {
		if strings.HasPrefix(tpl[i:], "{{") {
			end := strings.Index(tpl[i+2:], "}}")
			if end >= 0 {
				name := tpl[i+2 : i+2+end]
				if validName(name) {
					if v, ok := vals[name]; ok {
						b.WriteString(v)
						i += end + 4
						continue
					}
				}
			}
		}
		b.WriteByte(tpl[i])
		i++
	}
	return tidy(b.String())
}

func validName(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z') && c != '_' {
			return false
		}
	}
	return true
}

func tidy(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if l == "" && (len(out) == 0 || out[len(out)-1] == "") {
			continue
		}
		out = append(out, l)
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

// ClipWords is for text a length cap may have cut mid-word (thought, note): a string shorter than n code points is
// unchanged; else its first n-1 code points, cut back to the last whitespace when that falls in the second half,
// trimmed, followed by "…".
func ClipWords(s string, n int) string {
	r := []rune(s)
	if len(r) < n || n <= 1 {
		return s
	}
	r = r[:n-1]
	for i := len(r) - 1; i >= n/2; i-- {
		if isSpace(r[i]) {
			r = r[:i]
			break
		}
	}
	return TrimSpace(string(r)) + "…"
}

// StripName removes the character's own name from the start of a thought, with what follows it (spaces, `,` `:`
// `-`, or `'s`), and upper-cases the first letter left. Small models write "Tilda needs to..." whatever the prompt.
func StripName(s, name string) string {
	if name == "" || len(s) < len(name) || !strings.EqualFold(s[:len(name)], name) {
		return s
	}
	rest := s[len(name):]
	if !(rest == "" || strings.HasPrefix(rest, "'s ") || strings.HasPrefix(rest, "’s ") || strings.IndexFunc(rest[:1], func(r rune) bool { return isSpace(r) || r == ',' || r == ':' || r == '-' }) == 0) {
		return s
	}
	rest = strings.TrimPrefix(strings.TrimPrefix(rest, "'s "), "’s ")
	rest = strings.TrimLeftFunc(rest, func(r rune) bool { return isSpace(r) || r == ',' || r == ':' || r == '-' })
	if rest == "" {
		return s
	}
	rr := []rune(rest)
	rr[0] = []rune(strings.ToUpper(string(rr[0])))[0]
	return string(rr)
}

// TrimSpace removes the playkit's whitespace (see isSpace) from both ends.
func TrimSpace(s string) string { return strings.TrimFunc(s, isSpace) }

// joinList joins with ", ".
func joinList(items []string) string { return strings.Join(items, ", ") }
