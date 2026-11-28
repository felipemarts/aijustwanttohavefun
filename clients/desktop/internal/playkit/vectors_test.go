package playkit

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// The golden vectors live in clients/playkit/vectors and are shared with the TypeScript core. With
// PLAYKIT_UPDATE=1 the expectations are rewritten from this implementation (for authoring new cases: review the
// diff by eye before committing); otherwise every expectation must match exactly.

var vectorsDir = filepath.Join("..", "..", "..", "playkit", "vectors")

func update() bool { return os.Getenv("PLAYKIT_UPDATE") == "1" }

func loadVectors(t *testing.T, name string) jv.Value {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	v, err := jv.ParseBytes(b)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

// pretty writes JSON indented by one space, member order kept, without HTML escaping (readable prompts).
func pretty(v jv.Value) []byte {
	var b bytes.Buffer
	var w func(v jv.Value, ind string)
	str := func(s string) {
		var sb bytes.Buffer
		enc := json.NewEncoder(&sb)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(s)
		b.Write(bytes.TrimRight(sb.Bytes(), "\n"))
	}
	w = func(v jv.Value, ind string) {
		switch v.Kind {
		case jv.Array:
			if len(v.A) == 0 {
				b.WriteString("[]")
				return
			}
			simple := true
			for _, x := range v.A {
				simple = simple && x.Kind != jv.Array && x.Kind != jv.Object
			}
			if simple {
				b.WriteByte('[')
				for i, x := range v.A {
					if i > 0 {
						b.WriteString(", ")
					}
					w(x, ind)
				}
				b.WriteByte(']')
				return
			}
			b.WriteString("[\n")
			for i, x := range v.A {
				b.WriteString(ind + " ")
				w(x, ind+" ")
				if i < len(v.A)-1 {
					b.WriteByte(',')
				}
				b.WriteByte('\n')
			}
			b.WriteString(ind + "]")
		case jv.Object:
			if len(v.O) == 0 {
				b.WriteString("{}")
				return
			}
			b.WriteString("{\n")
			for i, m := range v.O {
				b.WriteString(ind + " ")
				str(m.Key)
				b.WriteString(": ")
				w(m.Val, ind+" ")
				if i < len(v.O)-1 {
					b.WriteByte(',')
				}
				b.WriteByte('\n')
			}
			b.WriteString(ind + "}")
		case jv.String:
			str(v.S)
		default:
			b.WriteString(jv.Write(v))
		}
	}
	w(v, "")
	b.WriteByte('\n')
	return b.Bytes()
}

// check compares or (in update mode) stores case.expect.
func check(t *testing.T, c *jv.Value, got jv.Value, label string) {
	t.Helper()
	if update() {
		c.Set("expect", got)
		return
	}
	want, ok := c.Get("expect")
	if !ok || want.Kind == jv.Null {
		t.Errorf("%s: no expectation (run with PLAYKIT_UPDATE=1 and review)", label)
		return
	}
	same := jv.Canon(want) == jv.Canon(got)
	if s, ok := got.Get("schema"); ok {
		// Member order is part of a schema (constrained decoders emit properties in that order).
		ws, _ := want.Get("schema")
		same = same && jv.Equal(ws, s)
	}
	if !same {
		t.Errorf("%s:\n got: %s\nwant: %s", label, string(pretty(got)), string(pretty(want)))
	}
}

func save(t *testing.T, name string, doc jv.Value) {
	if !update() {
		return
	}
	if err := os.WriteFile(filepath.Join(vectorsDir, name), pretty(doc), 0o644); err != nil {
		t.Fatal(err)
	}
}

func decode[T any](t *testing.T, v jv.Value) T {
	t.Helper()
	var x T
	if err := json.Unmarshal([]byte(jv.Write(v)), &x); err != nil {
		t.Fatal(err)
	}
	return x
}

func schemaDoc(t *testing.T) *SchemaDoc {
	b, err := os.ReadFile(filepath.Join(vectorsDir, "schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	d, err := ParseSchemaDoc(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func messagesValue(msgs []Message) jv.Value {
	out := jv.Arr()
	for _, m := range msgs {
		out.A = append(out.A, jv.Obj("role", jv.Str(m.Role), "content", jv.Str(m.Content)))
	}
	return out
}

func turnInput(t *testing.T, v jv.Value) TurnInput {
	in := decode[TurnInput](t, v)
	// encoding/json leaves jv fields as given; a JSON null observation or me stays Kind Null.
	return in
}

func menus(t *testing.T, k *Kit, doc *SchemaDoc) []Menu {
	cases, _ := loadVectors(t, "prompts.json").Get("cases")
	var out []Menu
	for _, c := range cases.A {
		in, _ := c.Get("input")
		out = append(out, k.BuildTurn(doc, turnInput(t, in)).Menu)
	}
	return out
}

func TestPromptVectors(t *testing.T) {
	k := MustLoad()
	doc := schemaDoc(t)
	file := loadVectors(t, "prompts.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		name, _ := c.Get("name")
		in, _ := c.Get("input")
		turn := k.BuildTurn(doc, turnInput(t, in))
		got := jv.Obj("messages", messagesValue(turn.Messages), "menu", jv.StrArr(turn.Menu.Names()), "schema", turn.Menu.Schema)
		check(t, c, got, name.S)
	}
	file.Set("cases", cases)
	save(t, "prompts.json", file)
}

func TestPlannerVectors(t *testing.T) {
	k := MustLoad()
	doc := schemaDoc(t)
	mb, err := os.ReadFile(filepath.Join(vectorsDir, "map.json"))
	if err != nil {
		t.Fatal(err)
	}
	wm, err := ParseWorldMap(string(mb))
	if err != nil {
		t.Fatal(err)
	}
	file := loadVectors(t, "planner.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		name, _ := c.Get("name")
		in, _ := c.Get("input")
		ti := turnInput(t, in)
		ti.Map = wm
		turn := k.BuildTurn(doc, ti)
		got := jv.Obj("mode", jv.Str(turn.Mode), "end", jv.Str(turn.End), "menu", jv.StrArr(turn.Menu.Names()), "messages", messagesValue(turn.Messages), "schema", turn.Menu.Schema)
		check(t, c, got, name.S)
	}
	file.Set("cases", cases)
	save(t, "planner.json", file)
}

func decisionValue(d Decision) jv.Value {
	p := d.Params
	if p.Kind != jv.Object {
		p = jv.Obj()
	}
	return jv.Obj("thought", jv.Str(d.Thought), "action", jv.Str(d.Action), "params", p, "note", jv.Str(d.Note))
}

func TestDecisionVectors(t *testing.T) {
	k := MustLoad()
	ms := menus(t, k, schemaDoc(t))
	file := loadVectors(t, "decisions.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		name, _ := c.Get("name")
		mf, _ := c.Get("menuFrom")
		raw, _ := c.Get("raw")
		menu := ms[int(mf.N)]
		var first jv.Value
		if d, p := k.Decide(raw.S, menu); p == "" {
			first = jv.Obj("ok", jv.BoolV(true), "decision", decisionValue(d))
		} else {
			first = jv.Obj("ok", jv.BoolV(false), "problem", jv.Str(p))
		}
		got := jv.Obj("first", first)
		if retry, ok := c.Get("retry"); ok {
			var problems []string
			res := k.Resolve(menu, raw.S, func(problem string) (string, error) {
				problems = append(problems, problem)
				if retry.Kind != jv.String {
					return "", errors.New("engine error")
				}
				return retry.S, nil
			})
			final := jv.Obj("source", jv.Str(res.Source))
			if res.Source == "none" {
				final.Set("decision", jv.NullV())
			} else {
				final.Set("decision", decisionValue(res.Decision))
			}
			got.Set("final", final)
			// The retry carries the retry template filled with the first problem.
			if len(problems) == 1 {
				msgs := k.RetryMessages([]Message{{Role: "user", Content: "turn"}}, raw.S, problems[0])
				got.Set("retryMessage", jv.Str(msgs[len(msgs)-1].Content))
			}
		}
		check(t, c, got, name.S)
	}
	file.Set("cases", cases)
	save(t, "decisions.json", file)
}

func TestTextVectors(t *testing.T) {
	k := MustLoad()
	_ = k
	file := loadVectors(t, "text.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		fn, _ := c.Get("fn")
		in, _ := c.Get("in")
		n, _ := c.Get("n")
		var got jv.Value
		switch fn.S {
		case "oneLine":
			got = jv.Str(OneLine(in.S))
		case "clip":
			got = jv.Str(Clip(in.S, int(n.N)))
		case "plain":
			got = jv.Str(Plain(in.S, int(n.N)))
		case "quoted":
			got = jv.Str(Quoted(in.S, int(n.N)))
		case "quote":
			got = jv.Str(jv.Quote(in.S))
		case "render":
			tpl, _ := c.Get("tpl")
			vals, _ := c.Get("vals")
			m := map[string]string{}
			for _, kv := range vals.O {
				m[kv.Key] = kv.Val.S
			}
			got = jv.Str(Render(tpl.S, m))
		case "clipWords":
			got = jv.Str(ClipWords(in.S, int(n.N)))
		case "stripName":
			nm, _ := c.Get("charName")
			got = jv.Str(StripName(in.S, nm.S))
		case "number":
			got = jv.Str(jv.FormatNumber(in.N))
		case "canon":
			got = jv.Str(jv.Canon(in))
		default:
			t.Fatalf("unknown fn %s", fn.S)
		}
		check(t, c, got, fn.S+" "+jv.Write(in))
	}
	file.Set("cases", cases)
	save(t, "text.json", file)
}

func memoryValue(m any) jv.Value {
	v, err := jv.Parse(mustJSON(m))
	if err != nil {
		panic(err)
	}
	return v
}

func mustJSON(x any) string {
	b, err := json.Marshal(x)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestMemoryVectors(t *testing.T) {
	k := MustLoad()
	file := loadVectors(t, "memory.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		fn, _ := c.Get("fn")
		name, _ := c.Get("name")
		switch fn.S {
		case "remember":
			mv, _ := c.Get("memory")
			m := decode[Memory](t, mv)
			if m.Notes == nil {
				m.Notes = []string{}
			}
			var r *Recent
			if rv, _ := c.Get("recent"); rv.Kind == jv.Object {
				x := decode[Recent](t, rv)
				r = &x
			}
			note, _ := c.Get("note")
			cv, _ := c.Get("chat")
			chat := decode[[]ChatLine](t, cv)
			compact := k.Remember(&m, r, note.S, chat)
			if m.Recent == nil {
				m.Recent = []Recent{}
			}
			if m.Chat == nil {
				m.Chat = []ChatLine{}
			}
			check(t, c, jv.Obj("memory", memoryValue(m), "compact", jv.BoolV(compact)), name.S)
		case "track":
			mv, _ := c.Get("memory")
			m := decode[Memory](t, mv)
			uv, _ := c.Get("update")
			var u Update
			u.Before, _ = uv.Get("before")
			u.After, _ = uv.Get("after")
			act, _ := uv.Get("action")
			u.Action = act.S
			u.Params, _ = uv.Get("params")
			okv, _ := uv.Get("ok")
			u.OK = okv.B
			cv, _ := uv.Get("chat")
			u.Chat = decode[[]ChatLine](t, cv)
			self, _ := uv.Get("self")
			u.Self = self.S
			lost, _ := uv.Get("lost")
			u.Lost = lost.B
			k.Track(&m, u)
			check(t, c, jv.Obj("memory", memoryValue(m)), name.S)
		case "stuck":
			mv, _ := c.Get("memory")
			m := decode[Memory](t, mv)
			check(t, c, jv.Str(k.StuckReason(m)), name.S)
		case "observe":
			wv, _ := c.Get("world")
			w := decode[World](t, wv)
			obs, _ := c.Get("observation")
			k.Observe(&w, obs)
			from, _ := c.Get("from")
			to, _ := c.Get("to")
			check(t, c, jv.Obj("world", memoryValue(w), "path", jv.StrArr(w.Path(from.S, to.S))), name.S)
		case "compaction":
			cn, _ := c.Get("charName")
			nv, _ := c.Get("notes")
			notes := decode[[]string](t, nv)
			raw, _ := c.Get("raw")
			msgs, schema := k.CompactionTurn(cn.S, notes)
			check(t, c, jv.Obj("messages", messagesValue(msgs), "schema", schema, "notes", jv.StrArr(k.ApplyCompaction(raw.S, notes))), name.S)
		}
	}
	file.Set("cases", cases)
	save(t, "memory.json", file)
}

func TestChatVectors(t *testing.T) {
	k := MustLoad()
	file := loadVectors(t, "chat.json")
	cases, _ := file.Get("cases")
	for i := range cases.A {
		c := &cases.A[i]
		name, _ := c.Get("name")
		in, _ := c.Get("input")
		ci := decode[ChatInput](t, in)
		check(t, c, jv.Obj("messages", messagesValue(k.ChatTurn(ci))), name.S)
	}
	file.Set("cases", cases)
	save(t, "chat.json", file)
}

// TestKitInSync fails when internal/playkit/kit differs from clients/playkit (run `go generate ./internal/playkit`).
func TestKitInSync(t *testing.T) {
	src := filepath.Join("..", "..", "..", "playkit")
	files := []string{"playkit.json", filepath.Join("bench", "situations.json"), filepath.Join("vectors", "schema.json"), filepath.Join("vectors", "map.json")}
	prompts, _ := filepath.Glob(filepath.Join(src, "prompts", "*.txt"))
	for _, p := range prompts {
		rel, _ := filepath.Rel(src, p)
		files = append(files, rel)
	}
	for _, f := range files {
		a, err := os.ReadFile(filepath.Join(src, f))
		if err != nil {
			t.Fatal(err)
		}
		b, err := kitFS.ReadFile("kit/" + filepath.ToSlash(f))
		if err != nil {
			t.Fatalf("%s is not embedded: run go generate ./internal/playkit", f)
		}
		if !bytes.Equal(bytes.ReplaceAll(a, []byte("\r\n"), []byte("\n")), bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n"))) {
			t.Errorf("%s differs from clients/playkit: run go generate ./internal/playkit", f)
		}
	}
	if !strings.HasPrefix(MustLoad().Version, "2.") {
		t.Error("unexpected playkit version")
	}
}
