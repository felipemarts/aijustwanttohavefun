// Package bench is the situation bench (clients/playkit/README.md, section 11): recorded turn inputs with
// machine-checkable expectations, run through the real pipeline (menu rules, prompt, model, validation) with no game
// server. Code expectations need no model (they are also Go tests); model expectations score any engine.
package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

type CodeExpect struct {
	Mode           string            `json:"mode"`
	End            string            `json:"end"`
	First          string            `json:"first"`
	FirstParams    map[string]string `json:"firstParams"`
	FirstParamsNot map[string]string `json:"firstParamsNot"`
	Has            []string          `json:"has"`
	Lacks          []string          `json:"lacks"`
	MovesLack      []string          `json:"movesLack"`
}

type ModelExpect struct {
	Actions          []string          `json:"actions"`
	ActionsNot       []string          `json:"actionsNot"`
	Params           map[string]string `json:"params"`
	ParamsNot        map[string]string `json:"paramsNot"`
	ParamsIfMove     map[string]string `json:"paramsIfMove"`
	Lang             string            `json:"lang"`
	Crude            *bool             `json:"crude"`
	NotSimilarToSaid bool              `json:"notSimilarToSaid"`
	ThoughtLang      string            `json:"thoughtLang"`
}

type Situation struct {
	ID     string          `json:"id"`
	About  string          `json:"about"`
	Input  json.RawMessage `json:"input"`
	Expect struct {
		Code  CodeExpect  `json:"code"`
		Model ModelExpect `json:"model"`
	} `json:"expect"`
}

// Bench is situations.json plus the schema document and the map it uses.
type Bench struct {
	Words struct {
		Crude map[string][]string `json:"crude"`
		Lang  map[string][]string `json:"lang"`
	} `json:"words"`
	Situations []Situation `json:"situations"`
	Doc        *playkit.SchemaDoc
	Map        *playkit.WorldMap
}

// Load reads the bench files: situations.json, the schema document and the map.
func Load(situations, schema, worldMap []byte) (*Bench, error) {
	b := &Bench{}
	if err := json.Unmarshal(situations, b); err != nil {
		return nil, fmt.Errorf("situations: %w", err)
	}
	doc, err := playkit.ParseSchemaDoc(string(schema))
	if err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	m, err := playkit.ParseWorldMap(string(worldMap))
	if err != nil {
		return nil, fmt.Errorf("map: %w", err)
	}
	b.Doc, b.Map = doc, m
	return b, nil
}

// Turn builds a situation's turn.
func (b *Bench) Turn(k *playkit.Kit, s Situation) (playkit.Turn, playkit.TurnInput, error) {
	var in playkit.TurnInput
	if err := json.Unmarshal(s.Input, &in); err != nil {
		return playkit.Turn{}, in, err
	}
	in.Map = b.Map
	return k.BuildTurn(b.Doc, in), in, nil
}

func enumOf(params jv.Value, name string) []string {
	props, _ := params.Get("properties")
	node, _ := props.Get(name)
	en, _ := node.Get("enum")
	var out []string
	for _, e := range en.A {
		out = append(out, e.Text())
	}
	return out
}

func names(m playkit.Menu) []string {
	var out []string
	for _, a := range m.Actions {
		out = append(out, a.Name)
	}
	return out
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// CheckCode returns the problems with the menu the code built (empty: pass).
func CheckCode(t playkit.Turn, e CodeExpect) []string {
	var p []string
	if e.Mode != "" && t.Mode != e.Mode {
		p = append(p, fmt.Sprintf("mode %q, want %q", t.Mode, e.Mode))
	}
	if t.End != e.End {
		p = append(p, fmt.Sprintf("end %q, want %q", t.End, e.End))
	}
	ns := names(t.Menu)
	if e.First != "" {
		if len(ns) == 0 || ns[0] != e.First {
			p = append(p, fmt.Sprintf("first option %v, want %s", ns, e.First))
		} else {
			for k, v := range e.FirstParams {
				if en := enumOf(t.Menu.Actions[0].Params, k); len(en) != 1 || en[0] != v {
					p = append(p, fmt.Sprintf("first option %s=%v, want %s", k, en, v))
				}
			}
		}
	}
	if len(t.Menu.Actions) > 0 {
		for k, v := range e.FirstParamsNot {
			if has(enumOf(t.Menu.Actions[0].Params, k), v) {
				p = append(p, fmt.Sprintf("first option allows %s=%s", k, v))
			}
		}
	}
	for _, a := range e.Has {
		if !has(ns, a) {
			p = append(p, "menu lacks "+a)
		}
	}
	for _, a := range e.Lacks {
		if has(ns, a) {
			p = append(p, "menu has "+a)
		}
	}
	for _, a := range t.Menu.Actions {
		if a.Name == "move" {
			for _, d := range e.MovesLack {
				if has(enumOf(a.Params, "dir"), d) {
					p = append(p, "a move offers "+d)
				}
			}
		}
	}
	return p
}

func countWords(text string, list []string) int {
	words := playkit.Words(text)
	low := " " + strings.Join(words, " ") + " "
	n := 0
	for _, w := range list {
		if strings.Contains(low, " "+strings.Join(playkit.Words(w), " ")+" ") {
			n++
		}
	}
	return n
}

// CheckModel returns the problems with the model's final decision.
func (b *Bench) CheckModel(k *playkit.Kit, in playkit.TurnInput, d playkit.Decision, e ModelExpect) []string {
	var p []string
	if len(e.Actions) > 0 && !has(e.Actions, d.Action) {
		p = append(p, fmt.Sprintf("action %s, want one of %v", d.Action, e.Actions))
	}
	if has(e.ActionsNot, d.Action) {
		p = append(p, "action "+d.Action+" is not wanted")
	}
	param := func(k string) string {
		v, _ := d.Params.Get(k)
		return v.Text()
	}
	for k, v := range e.Params {
		if param(k) != v {
			p = append(p, fmt.Sprintf("%s=%q, want %q", k, param(k), v))
		}
	}
	for k, v := range e.ParamsNot {
		if param(k) == v {
			p = append(p, fmt.Sprintf("%s=%q is not wanted", k, v))
		}
	}
	if d.Action == "move" {
		for k, v := range e.ParamsIfMove {
			if param(k) != v {
				p = append(p, fmt.Sprintf("move %s=%q, want %q", k, param(k), v))
			}
		}
	}
	text := param("text")
	inLang := func(s, lang, what string) {
		mine, others := countWords(s, b.Words.Lang[lang]), 0
		for l, list := range b.Words.Lang {
			if l != lang {
				if c := countWords(s, list); c > others {
					others = c
				}
			}
		}
		if s == "" || mine <= others {
			p = append(p, fmt.Sprintf("%s not in %s (%d vs %d marker words)", what, lang, mine, others))
		}
	}
	if e.Lang != "" {
		inLang(text, e.Lang, "text")
	}
	if e.ThoughtLang != "" {
		inLang(d.Thought, e.ThoughtLang, "thought")
	}
	if e.Crude != nil {
		crude := 0
		for _, list := range b.Words.Crude {
			crude += countWords(text, list)
		}
		if *e.Crude && crude == 0 {
			p = append(p, "no crude word")
		}
		if !*e.Crude && crude > 0 {
			p = append(p, "crude words in a polite persona")
		}
	}
	if e.NotSimilarToSaid {
		for _, s := range in.Memory.Said {
			if k.Similar(text, s) {
				p = append(p, "too close to "+s)
			}
		}
	}
	return p
}

// Result is one situation run.
type Result struct {
	ID       string   `json:"id"`
	Code     []string `json:"codeProblems"`
	Model    []string `json:"modelProblems"`
	Pass     bool     `json:"pass"`
	Source   string   `json:"source"`
	Action   string   `json:"action"`
	Params   string   `json:"params"`
	Thought  string   `json:"thought"`
	Answer   string   `json:"answer"`
	InferMs  int64    `json:"inferMs"`
	Tokens   int      `json:"tokens"`
	TPS      float64  `json:"tps"`
	Repeat   int      `json:"repeat"`
	Mode     string   `json:"mode"`
	CodeOnly bool     `json:"codeOnly"`
}

// Options select situations and repetitions.
type Options struct {
	Only   []string
	Repeat int
}

// Run runs every selected situation through the engine and writes a line per run, then a summary.
func (b *Bench) Run(ctx context.Context, k *playkit.Kit, p engine.Provider, o Options, w io.Writer) ([]Result, error) {
	if o.Repeat < 1 {
		o.Repeat = 1
	}
	var out []Result
	start := time.Now()
	var modelMs int64
	for _, s := range b.Situations {
		if len(o.Only) > 0 && !has(o.Only, s.ID) {
			continue
		}
		for rep := 1; rep <= o.Repeat; rep++ {
			turn, in, err := b.Turn(k, s)
			if err != nil {
				return out, fmt.Errorf("%s: %w", s.ID, err)
			}
			r := Result{ID: s.ID, Repeat: rep, Mode: turn.Mode, Code: CheckCode(turn, s.Expect.Code)}
			if turn.End != "" || len(turn.Menu.Actions) == 0 {
				r.CodeOnly, r.Pass, r.Source = true, len(r.Code) == 0, "none"
				out = append(out, r)
				fmt.Fprintf(w, "%-4s %-20s code only (end %q) %s\n", verdict(r.Pass), s.ID, turn.End, strings.Join(r.Code, "; "))
				continue
			}
			schema := turn.Menu.Schema
			req := func(msgs []playkit.Message) engine.Request {
				return engine.Request{Messages: msgs, Schema: &schema, MaxTokens: k.Sampling.MaxTokens, Temperature: k.Sampling.Temperature, TopK: k.Sampling.TopK, RepeatPenalty: k.Sampling.RepeatPenalty}
			}
			res, err := p.Complete(ctx, req(turn.Messages))
			if err != nil {
				return out, fmt.Errorf("%s: %w", s.ID, err)
			}
			r.InferMs, r.Tokens, r.TPS, r.Answer = res.Elapsed.Milliseconds(), res.CompletionTokens, res.TokensPerSecond, res.Text
			resolved := k.Resolve(turn.Menu, res.Text, func(problem string) (string, error) {
				r2, err := p.Complete(ctx, req(k.RetryMessages(turn.Messages, res.Text, problem)))
				if err != nil {
					return "", err
				}
				r.InferMs += r2.Elapsed.Milliseconds()
				r.Tokens += r2.CompletionTokens
				return r2.Text, nil
			})
			modelMs += r.InferMs
			r.Source = resolved.Source
			d := resolved.Decision
			if d.Params.Kind != jv.Object {
				d.Params = jv.Obj()
			}
			r.Action, r.Params, r.Thought = d.Action, jv.Canon(d.Params), d.Thought
			if resolved.Source == "none" {
				r.Model = []string{"no decision"}
			} else {
				r.Model = b.CheckModel(k, in, d, s.Expect.Model)
			}
			r.Pass = len(r.Code) == 0 && len(r.Model) == 0
			out = append(out, r)
			fmt.Fprintf(w, "%-4s %-20s %-6s %s %s  (%.1fs, %.1f tok/s)%s\n", verdict(r.Pass), s.ID, r.Source, r.Action, r.Params, float64(r.InferMs)/1000, r.TPS, problems(r))
		}
	}
	summary(out, w, time.Since(start), modelMs)
	return out, nil
}

func verdict(ok bool) string {
	if ok {
		return "PASS"
	}
	return "FAIL"
}

func problems(r Result) string {
	all := append(append([]string{}, r.Code...), r.Model...)
	if len(all) == 0 {
		return ""
	}
	return "\n      " + strings.Join(all, "; ")
}

func summary(rs []Result, w io.Writer, wall time.Duration, modelMs int64) {
	pass, first, calls := 0, 0, 0
	var tps []float64
	failed := map[string]int{}
	for _, r := range rs {
		if r.Pass {
			pass++
		} else {
			failed[r.ID]++
		}
		if !r.CodeOnly {
			calls++
			if r.Source == "first" {
				first++
			}
			if r.TPS > 0 {
				tps = append(tps, r.TPS)
			}
		}
	}
	sort.Float64s(tps)
	med := 0.0
	if len(tps) > 0 {
		med = tps[len(tps)/2]
	}
	fmt.Fprintf(w, "\n%d/%d passed; first answer valid %d/%d; median %.1f tok/s; model time %.1f min; wall %.1f min\n",
		pass, len(rs), first, calls, med, float64(modelMs)/60000, wall.Minutes())
	if len(failed) > 0 {
		var ids []string
		for id := range failed {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		fmt.Fprintf(w, "failed: %s\n", strings.Join(ids, ", "))
	}
}
