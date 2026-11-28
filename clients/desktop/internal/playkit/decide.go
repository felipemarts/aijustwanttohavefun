package playkit

import (
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// Decision is what the model chose, after validation.
type Decision struct {
	Thought string   `json:"thought"`
	Action  string   `json:"action"`
	Params  jv.Value `json:"params"`
	Note    string   `json:"note"`
}

// ErrNotJSON is the one message for every answer that does not contain one well-formed JSON object.
const ErrNotJSON = "the answer is not one valid JSON object"

// Extract finds the decision object in a raw answer: the answer is cut to rawMax code points; a leading
// `<think>...</think>` block is removed (an unclosed one is an error); then the text from the first `{` to its
// matching `}` (strings and escapes respected) is parsed strictly (order kept, duplicate keys refused). Text before
// and after the object is ignored.
func (k *Kit) Extract(raw string) (jv.Value, string) {
	raw = Clip(strings.ToValidUTF8(raw, "�"), k.Decision.RawMax)
	t := strings.TrimLeft(raw, " \t\r\n")
	if strings.HasPrefix(t, "<think>") {
		end := strings.Index(t, "</think>")
		if end < 0 {
			return jv.Value{}, ErrNotJSON
		}
		t = t[end+len("</think>"):]
	}
	start := strings.IndexByte(t, '{')
	if start < 0 {
		return jv.Value{}, ErrNotJSON
	}
	depth, inStr, esc := 0, false, false
	end := -1
	for i := start; i < len(t) && end < 0; i++ {
		c := t[i]
		switch {
		case inStr && esc:
			esc = false
		case inStr && c == '\\':
			esc = true
		case inStr && c == '"':
			inStr = false
		case inStr:
		case c == '"':
			inStr = true
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
	}
	if end < 0 {
		return jv.Value{}, ErrNotJSON
	}
	v, err := jv.Parse(t[start : end+1])
	if err != nil || v.Kind != jv.Object {
		return jv.Value{}, ErrNotJSON
	}
	return v, ""
}

var simpleKey = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func pathJoin(base, key string) string {
	if !simpleKey.MatchString(key) {
		key = jv.Quote(Clip(key, 40))
	}
	if base == "" {
		return key
	}
	return base + "." + key
}

func pathIndex(base string, i int) string { return base + "[" + jv.FormatNumber(float64(i)) + "]" }

// Validate turns an extracted object into a Decision against the menu, or returns the first problem found, as
// "<path>: <problem>". Order of checks: README, "Validation".
func (k *Kit) Validate(v jv.Value, menu Menu) (Decision, string) {
	if p := k.forbiddenKeys(v, ""); p != "" {
		return Decision{}, p
	}
	for _, m := range v.O {
		switch m.Key {
		case "thought", "action", "params", "note":
		default:
			return Decision{}, pathJoin("", m.Key) + ": is not allowed"
		}
	}
	d := Decision{Params: jv.Obj()}
	av, ok := v.Get("action")
	if !ok {
		return Decision{}, "action: is required"
	}
	names := menu.Names()
	if av.Kind != jv.String || !contains(names, av.S) {
		quoted := make([]string, len(names))
		for i, n := range names {
			quoted[i] = jv.Quote(n)
		}
		return Decision{}, "action: must be one of: " + strings.Join(quoted, ", ")
	}
	d.Action = av.S
	for _, f := range []struct {
		key string
		max int
		dst *string
	}{{"thought", k.Decision.ThoughtMax, &d.Thought}, {"note", k.Decision.NoteMax, &d.Note}} {
		x, ok := v.Get(f.key)
		if !ok || x.Kind == jv.Null {
			continue
		}
		if x.Kind != jv.String {
			return Decision{}, f.key + ": must be a string"
		}
		*f.dst = ClipWords(x.S, f.max)
	}
	if pv, ok := v.Get("params"); ok && pv.Kind != jv.Null {
		d.Params = pv
	}
	entry, _ := menu.Find(d.Action)
	if p := validate(d.Params, entry.Params, "params"); p != "" {
		return Decision{}, p
	}
	if p := k.forbiddenText(d.Params, "params"); p != "" {
		return Decision{}, p
	}
	if p := k.tooSimilar(d, menu.Said); p != "" {
		return Decision{}, p
	}
	return d, ""
}

// Decide is Extract then Validate.
func (k *Kit) Decide(raw string, menu Menu) (Decision, string) {
	v, problem := k.Extract(raw)
	if problem != "" {
		return Decision{}, problem
	}
	return k.Validate(v, menu)
}

// Fallback is the safe action used when the retry failed too: the first of fallbackActions on the menu, with no
// params. ok is false when none is on the menu (the turn then takes no action).
func (k *Kit) Fallback(menu Menu) (Decision, bool) {
	for _, name := range k.FallbackActions {
		if _, ok := menu.Find(name); ok {
			return Decision{Action: name, Params: jv.Obj()}, true
		}
	}
	return Decision{}, false
}

func (k *Kit) forbiddenKeys(v jv.Value, path string) string {
	switch v.Kind {
	case jv.Object:
		for _, m := range v.O {
			p := pathJoin(path, m.Key)
			if contains(k.Decision.ForbiddenKeys, m.Key) {
				return p + ": is not allowed"
			}
			if r := k.forbiddenKeys(m.Val, p); r != "" {
				return r
			}
		}
	case jv.Array:
		for i, x := range v.A {
			if r := k.forbiddenKeys(x, pathIndex(path, i)); r != "" {
				return r
			}
		}
	}
	return ""
}

func (k *Kit) forbiddenText(v jv.Value, path string) string {
	switch v.Kind {
	case jv.String:
		low := strings.ToLower(v.S)
		for _, f := range k.Decision.ForbiddenText {
			if strings.Contains(low, strings.ToLower(f)) {
				return path + ": contains forbidden text"
			}
		}
	case jv.Object:
		for _, m := range v.O {
			if r := k.forbiddenText(m.Val, pathJoin(path, m.Key)); r != "" {
				return r
			}
		}
	case jv.Array:
		for i, x := range v.A {
			if r := k.forbiddenText(x, pathIndex(path, i)); r != "" {
				return r
			}
		}
	}
	return ""
}

var typeNames = map[string]string{"string": "a string", "integer": "an integer", "number": "a number", "boolean": "a boolean", "object": "an object", "array": "an array", "null": "null"}

func typeOK(v jv.Value, t string) bool {
	switch t {
	case "string":
		return v.Kind == jv.String
	case "integer":
		return v.IsInt()
	case "number":
		return v.Kind == jv.Number
	case "boolean":
		return v.Kind == jv.Bool
	case "object":
		return v.Kind == jv.Object
	case "array":
		return v.Kind == jv.Array
	case "null":
		return v.Kind == jv.Null
	}
	return true
}

func valueList(vals []jv.Value) string {
	parts := make([]string, len(vals))
	for i, x := range vals {
		parts[i] = jv.Canon(x)
	}
	return strings.Join(parts, ", ")
}

// validate checks v against the JSON Schema subset the playkit uses and returns the first problem. Keywords are
// checked in this order: anyOf, type, const, enum, string bounds and pattern, number bounds, array (items,
// prefixItems, bounds), object (required in schema order, then members in input order).
func validate(v, s jv.Value, path string) string {
	if s.Kind == jv.Bool {
		if !s.B {
			return path + ": is not allowed"
		}
		return ""
	}
	if s.Kind != jv.Object {
		return ""
	}
	if any, ok := s.Get("anyOf"); ok {
		for _, alt := range any.A {
			if validate(v, alt, path) == "" {
				return ""
			}
		}
		return path + ": does not match any allowed form"
	}
	if t, ok := s.Get("type"); ok && t.Kind == jv.String && !typeOK(v, t.S) {
		return path + ": must be " + typeNames[t.S]
	}
	if c, ok := s.Get("const"); ok && !jv.Equal(c, v) {
		return path + ": must be " + jv.Canon(c)
	}
	if e, ok := s.Get("enum"); ok && e.Kind == jv.Array {
		found := false
		for _, x := range e.A {
			found = found || jv.Equal(x, v)
		}
		if !found {
			return path + ": must be one of: " + valueList(e.A)
		}
	}
	switch v.Kind {
	case jv.String:
		n := utf8.RuneCountInString(v.S)
		if m, ok := s.Get("minLength"); ok && float64(n) < m.N {
			return path + ": must be at least " + jv.FormatNumber(m.N) + " characters"
		}
		if m, ok := s.Get("maxLength"); ok && float64(n) > m.N {
			return path + ": must be at most " + jv.FormatNumber(m.N) + " characters"
		}
		if p, ok := s.Get("pattern"); ok {
			if re, err := regexp.Compile(p.S); err == nil && !re.MatchString(v.S) {
				return path + ": does not match the expected format"
			}
		}
	case jv.Number:
		if m, ok := s.Get("minimum"); ok && v.N < m.N {
			return path + ": must be >= " + jv.FormatNumber(m.N)
		}
		if m, ok := s.Get("maximum"); ok && v.N > m.N {
			return path + ": must be <= " + jv.FormatNumber(m.N)
		}
		if math.IsNaN(v.N) {
			return path + ": must be a number"
		}
	case jv.Array:
		pre, hasPre := s.Get("prefixItems")
		items, hasItems := s.Get("items")
		for i, x := range v.A {
			p := pathIndex(path, i)
			if hasPre && i < len(pre.A) {
				if r := validate(x, pre.A[i], p); r != "" {
					return r
				}
			} else if hasItems {
				if r := validate(x, items, p); r != "" {
					return r
				}
			}
		}
		if m, ok := s.Get("minItems"); ok && float64(len(v.A)) < m.N {
			return path + ": must have at least " + jv.FormatNumber(m.N) + " items"
		}
		if m, ok := s.Get("maxItems"); ok && float64(len(v.A)) > m.N {
			return path + ": must have at most " + jv.FormatNumber(m.N) + " items"
		}
	case jv.Object:
		props, _ := s.Get("properties")
		if req, ok := s.Get("required"); ok {
			for _, r := range req.A {
				if !v.Has(r.S) {
					return pathJoin(path, r.S) + ": is required"
				}
			}
		}
		names, hasNames := s.Get("propertyNames")
		addl, hasAddl := s.Get("additionalProperties")
		for _, m := range v.O {
			p := pathJoin(path, m.Key)
			if hasNames {
				if r := validate(jv.Str(m.Key), names, p); r != "" {
					return p + ": is not an allowed name"
				}
			}
			if ps, ok := props.Get(m.Key); ok {
				if r := validate(m.Val, ps, p); r != "" {
					return r
				}
				continue
			}
			if hasAddl {
				if r := validate(m.Val, addl, p); r != "" {
					return r
				}
			}
		}
	}
	return ""
}

// Resolution is how a turn's decision was reached.
type Resolution struct {
	Decision Decision
	// Source: "first" (the first answer was valid), "retry", "fallback", or "none" (no action this turn).
	Source       string
	FirstProblem string
	RetryProblem string
}

// Resolve applies the decision rule: the first answer if valid; else one retry carrying the problem (retry returns
// the second answer; an error counts as an invalid answer); else the fallback action; else no action.
func (k *Kit) Resolve(menu Menu, first string, retry func(problem string) (string, error)) Resolution {
	d, p := k.Decide(first, menu)
	if p == "" {
		return Resolution{Decision: d, Source: "first"}
	}
	res := Resolution{FirstProblem: p}
	if retry != nil {
		raw, err := retry(p)
		if err == nil {
			d2, p2 := k.Decide(raw, menu)
			if p2 == "" {
				res.Decision, res.Source = d2, "retry"
				return res
			}
			res.RetryProblem = p2
		} else {
			res.RetryProblem = err.Error()
		}
	}
	if fb, ok := k.Fallback(menu); ok {
		res.Decision, res.Source = fb, "fallback"
		return res
	}
	res.Source = "none"
	return res
}
