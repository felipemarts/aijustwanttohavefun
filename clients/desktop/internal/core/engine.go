package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// Usual local addresses, probed read-only (GET) for the provider list. Never port 8080.
const (
	ollamaURL   = "http://127.0.0.1:11434"
	lmstudioURL = "http://127.0.0.1:1234"
)

type engineFile struct {
	Kind  string `json:"kind"`
	URL   string `json:"url,omitempty"`
	Model string `json:"model,omitempty"`
}

// engineMgr owns the engine choice, the built-in server and the one-inference-at-a-time lock.
type engineMgr struct {
	c       *Core
	builtin *engine.Builtin

	mu       sync.Mutex
	choice   engineFile
	provider engine.Provider
	status   string
	message  string
	tps      float64
	starting bool

	// lock: one inference at a time across all characters and chats.
	lock chan struct{}
}

func newEngineMgr(c *Core, cacheDir string) *engineMgr {
	m := &engineMgr{c: c, lock: make(chan struct{}, 1)}
	m.builtin = &engine.Builtin{CacheDir: cacheDir, Log: func(s string) { c.logf("engine: %s", s) }}
	m.choice = engineFile{Kind: "builtin"}
	_ = c.store.Load("engine.json", &m.choice)
	if m.choice.Kind == "" {
		m.choice.Kind = "builtin"
	}
	return m
}

func (m *engineMgr) state() EngineState {
	m.mu.Lock()
	ch, status, msg, tps := m.choice, m.status, m.message, m.tps
	m.mu.Unlock()
	hasKey := false
	if ch.Kind == "openai" {
		if k, err := m.c.secrets.Get("provider:openai"); err == nil && k != "" {
			hasKey = true
		}
	}
	st := EngineState{Choice: EngineChoiceView{Kind: ch.Kind, URL: ch.URL, Model: ch.Model, HasAPIKey: hasKey}, Status: status, Message: msg, TokensPerSecond: round1(tps)}
	if ch.Kind == "builtin" {
		b := m.builtin.Status()
		st.Builtin = &BuiltinInfo{Model: engine.ModelName, File: engine.ModelFile, LicenseName: engine.ModelLicense, LicenseURL: engine.ModelLicenseURL, BytesTotal: b.BytesTotal, BytesDone: b.BytesDone}
		switch b.State {
		case "downloading":
			st.Status = "downloading"
		case "not_installed":
			st.Status = "not_installed"
		case "error":
			st.Status = "error"
		case "starting":
			st.Status = "starting"
		case "ready":
			st.Status = "ready"
		case "stopped":
			if st.Status == "" || st.Status == "not_installed" || st.Status == "downloading" {
				st.Status = "starting"
			}
		}
		if b.Code != "" && b.State != "ready" && b.State != "stopped" {
			st.Message = m.c.tr("eng_" + b.Code)
		}
		if b.State == "ready" && status == "" {
			st.Status = "ready"
		}
	}
	if st.Status == "" {
		st.Status = "starting"
	}
	return st
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

func (m *engineMgr) publish() {
	s := m.state()
	m.c.emit(CoreEvent{Type: "engine", Engine: &s})
}

func (m *engineMgr) setStatus(status, msg string) {
	m.mu.Lock()
	m.status, m.message = status, msg
	m.mu.Unlock()
	m.publish()
}

// ensure returns a ready provider, starting the built-in server when needed.
func (m *engineMgr) ensure(ctx context.Context) (engine.Provider, error) {
	m.mu.Lock()
	if m.provider != nil {
		p := m.provider
		m.mu.Unlock()
		return p, nil
	}
	ch := m.choice
	m.mu.Unlock()
	switch ch.Kind {
	case "builtin":
		if m.builtin.Status().State == "not_installed" || m.builtin.Status().State == "downloading" {
			return nil, errors.New("the built-in model is not downloaded yet")
		}
		m.mu.Lock()
		if m.starting {
			m.mu.Unlock()
			return nil, errors.New("the engine is starting")
		}
		m.starting = true
		m.mu.Unlock()
		m.setStatus("starting", "")
		p, err := m.builtin.Start(ctx)
		m.mu.Lock()
		m.starting = false
		m.mu.Unlock()
		if err != nil {
			m.c.logf("engine: %s", playkit.Clip(playkit.OneLine(err.Error()), 300))
			m.setStatus("error", m.c.tr("eng_failed"))
			return nil, err
		}
		m.mu.Lock()
		m.provider = p
		m.mu.Unlock()
		m.setStatus("ready", "")
		return p, nil
	default:
		p, err := m.external(ch)
		if err != nil {
			m.setStatus("error", m.c.tr("eng_failed"))
			return nil, err
		}
		cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
		models, err := p.Models(cctx)
		cancel()
		if err != nil {
			m.setStatus("unreachable", m.c.tr("eng_unreachable"))
			return nil, err
		}
		if ch.Model == "" && len(models) > 0 {
			ch.Model = pickModel(models)
			m.mu.Lock()
			m.choice.Model = ch.Model
			m.mu.Unlock()
			_ = m.c.store.Save("engine.json", ch)
			p, _ = m.external(ch)
		}
		m.mu.Lock()
		m.provider = p
		m.mu.Unlock()
		m.setStatus("ready", "")
		return p, nil
	}
}

// pickModel prefers an LFM model, else the first.
func pickModel(models []string) string {
	for _, n := range models {
		if strings.Contains(strings.ToLower(n), "lfm") {
			return n
		}
	}
	return models[0]
}

func (m *engineMgr) external(ch engineFile) (engine.Provider, error) {
	switch ch.Kind {
	case "ollama":
		return &engine.Ollama{Base: ch.URL, Model: ch.Model}, nil
	case "lmstudio":
		return &engine.OpenAI{Base: ch.URL, Model: ch.Model, Extras: true}, nil
	case "openai":
		key, _ := m.c.secrets.Get("provider:openai")
		return &engine.OpenAI{Base: ch.URL, Model: ch.Model, APIKey: key}, nil
	}
	return nil, fmt.Errorf("unknown engine kind %q", ch.Kind)
}

// set changes the engine choice.
func (m *engineMgr) set(choice EngineChoice) (EngineState, error) {
	f := engineFile{Kind: choice.Kind, Model: strings.TrimSpace(choice.Model)}
	switch choice.Kind {
	case "builtin":
	case "ollama", "lmstudio", "openai":
		raw := choice.URL
		if raw == "" && choice.Kind == "ollama" {
			raw = ollamaURL
		}
		if raw == "" && choice.Kind == "lmstudio" {
			raw = lmstudioURL
		}
		u, err := engine.NormalizeURL(raw)
		if err != nil {
			return EngineState{}, errf(400, "INVALID_URL", err.Error())
		}
		f.URL = u
	default:
		return EngineState{}, errf(400, "INVALID", "kind must be builtin, ollama, lmstudio or openai")
	}
	if choice.Kind == "openai" && choice.APIKey != "" {
		if err := m.c.secrets.Set("provider:openai", choice.APIKey); err != nil {
			return EngineState{}, errf(500, "SECRETS", "could not store the API key")
		}
	}
	if err := m.c.store.Save("engine.json", f); err != nil {
		return EngineState{}, errf(500, "STORE", err.Error())
	}
	m.mu.Lock()
	old := m.choice
	m.choice, m.provider, m.status, m.message = f, nil, "", ""
	m.mu.Unlock()
	if old.Kind == "builtin" && f.Kind != "builtin" {
		m.builtin.Stop()
	}
	m.publish()
	go func() {
		if _, err := m.ensure(m.c.ctx); err == nil {
			m.c.wakeAll()
		}
	}()
	return m.state(), nil
}

// download starts (or resumes) the built-in download in the background.
func (m *engineMgr) download() EngineState {
	go func() {
		done := make(chan struct{})
		go func() {
			t := time.NewTicker(time.Second)
			defer t.Stop()
			for {
				select {
				case <-done:
					return
				case <-t.C:
					m.publish()
				}
			}
		}()
		err := m.builtin.Download(m.c.ctx)
		close(done)
		m.publish()
		if err == nil {
			m.mu.Lock()
			isBuiltin := m.choice.Kind == "builtin"
			m.mu.Unlock()
			if isBuiltin {
				if _, err := m.ensure(m.c.ctx); err == nil {
					m.c.wakeAll()
				}
			}
		}
	}()
	time.Sleep(50 * time.Millisecond)
	return m.state()
}

// pauseDownload stops the download and keeps the partial file; download() resumes it.
func (m *engineMgr) pauseDownload() EngineState {
	m.builtin.CancelDownload()
	time.Sleep(100 * time.Millisecond)
	m.publish()
	return m.state()
}

// cancelDownload stops the download and deletes the partial files.
func (m *engineMgr) cancelDownload() EngineState {
	m.builtin.CancelDownload()
	time.Sleep(200 * time.Millisecond)
	m.builtin.DeletePartial()
	m.publish()
	return m.state()
}

// probeURL tells what answers at a typed address: Ollama (/api/tags) or an OpenAI-compatible server (/v1/models).
func (m *engineMgr) probeURL(ctx context.Context, raw string) (ProviderInfo, error) {
	u, err := engine.NormalizeURL(raw)
	if err != nil {
		return ProviderInfo{}, errf(400, "INVALID_URL", err.Error())
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if models, err := (&engine.Ollama{Base: u}).Models(cctx); err == nil {
		return ProviderInfo{Kind: "ollama", Label: "Ollama", URL: u, Reachable: true, Models: nonNil(models)}, nil
	}
	cctx2, cancel2 := context.WithTimeout(ctx, 2*time.Second)
	defer cancel2()
	models, err := (&engine.OpenAI{Base: u}).Models(cctx2)
	kind, label := "openai", "OpenAI-compatible server"
	if strings.HasSuffix(u, ":1234") {
		kind, label = "lmstudio", "LM Studio"
	}
	return ProviderInfo{Kind: kind, Label: label, URL: u, Reachable: err == nil, Models: nonNil(models)}, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// infer runs one completion under the global lock.
// ErrTimeout: the engine accepted a request but did not answer in time.
var ErrTimeout = errors.New("the AI engine took too long to answer")

// requestTimeout is engine.timeoutBaseSeconds plus the token budget at engine.floorTokensPerSecond.
func (m *engineMgr) requestTimeout(maxTokens int) time.Duration {
	e := m.c.kit.Engine
	secs := float64(e.TimeoutBaseSeconds)
	if e.FloorTokensPerSecond > 0 {
		secs += float64(maxTokens) / e.FloorTokensPerSecond
	}
	return time.Duration(secs * float64(time.Second))
}

// infer runs one completion under the global lock, bounded by requestTimeout. A timeout or a failing engine puts
// the engine state to error (localised message; the detail goes to the program log, truncated).
func (m *engineMgr) infer(ctx context.Context, r engine.Request) (engine.Result, error) {
	p, err := m.ensure(ctx)
	if err != nil {
		return engine.Result{}, err
	}
	select {
	case m.lock <- struct{}{}:
	case <-ctx.Done():
		return engine.Result{}, ctx.Err()
	}
	defer func() { <-m.lock }()
	rctx, cancel := context.WithTimeout(ctx, m.requestTimeout(r.MaxTokens))
	defer cancel()
	res, err := p.Complete(rctx, r)
	if err != nil {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		switch {
		case errors.Is(rctx.Err(), context.DeadlineExceeded):
			m.c.logf("engine: no answer within %s", m.requestTimeout(r.MaxTokens))
			m.setStatus("error", m.c.tr("eng_timeout"))
			return res, ErrTimeout
		case errors.Is(err, engine.ErrUnreachable):
			m.mu.Lock()
			m.provider = nil
			m.mu.Unlock()
			m.setStatus("unreachable", m.c.tr("eng_unreachable"))
		default:
			m.c.logf("engine: %s", playkit.Clip(playkit.OneLine(err.Error()), 300))
			m.setStatus("error", m.c.tr("eng_failed"))
		}
		return res, err
	}
	m.mu.Lock()
	if res.TokensPerSecond > 0 {
		m.tps = res.TokensPerSecond
	}
	recovered := m.status != "ready"
	m.mu.Unlock()
	if recovered {
		m.setStatus("ready", "")
	}
	return res, nil
}

func (m *engineMgr) providers(ctx context.Context) []ProviderInfo {
	b := m.builtin.Status()
	out := []ProviderInfo{{Kind: "builtin", Label: "Built-in: " + engine.ModelName, Reachable: b.State != "not_installed" && b.State != "error", Models: []string{engine.ModelFile}}}
	probe := func(kind, label, url string, p engine.Provider) {
		cctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		defer cancel()
		models, err := p.Models(cctx)
		if models == nil {
			models = []string{}
		}
		out = append(out, ProviderInfo{Kind: kind, Label: label, URL: url, Reachable: err == nil, Models: models})
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	results := map[string]ProviderInfo{}
	for _, x := range []struct{ kind, label, url string }{{"ollama", "Ollama", ollamaURL}, {"lmstudio", "LM Studio", lmstudioURL}} {
		wg.Add(1)
		go func(kind, label, url string) {
			defer wg.Done()
			var p engine.Provider = &engine.OpenAI{Base: url}
			if kind == "ollama" {
				p = &engine.Ollama{Base: url}
			}
			cctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			defer cancel()
			models, err := p.Models(cctx)
			if models == nil {
				models = []string{}
			}
			mu.Lock()
			results[kind] = ProviderInfo{Kind: kind, Label: label, URL: url, Reachable: err == nil, Models: models}
			mu.Unlock()
		}(x.kind, x.label, x.url)
	}
	wg.Wait()
	out = append(out, results["ollama"], results["lmstudio"])
	m.mu.Lock()
	ch := m.choice
	m.mu.Unlock()
	if ch.Kind == "openai" && ch.URL != "" {
		if p, err := m.external(ch); err == nil {
			probe("openai", "OpenAI-compatible server", ch.URL, p)
		}
	} else {
		out = append(out, ProviderInfo{Kind: "openai", Label: "OpenAI-compatible server", Reachable: false, Models: []string{}})
	}
	return out
}

// test runs a short constrained completion.
func (m *engineMgr) test(ctx context.Context) EngineTest {
	schema := jv.Obj("type", jv.Str("object"),
		"properties", jv.Obj("greeting", jv.Obj("type", jv.Str("string"), "maxLength", jv.Int(60)), "ready", jv.Obj("type", jv.Str("boolean"))),
		"required", jv.StrArr([]string{"greeting", "ready"}), "additionalProperties", jv.BoolV(false))
	k := m.c.kit
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	res, err := m.infer(ctx, engine.Request{
		Messages:  []playkit.Message{{Role: "system", Content: "You are a character in a text game. Answer with JSON only."}, {Role: "user", Content: `Greet the village in a few words. Answer with {"greeting": "...", "ready": true}.`}},
		Schema:    &schema,
		MaxTokens: 80, Temperature: k.Sampling.Temperature, TopK: k.Sampling.TopK, RepeatPenalty: k.Sampling.RepeatPenalty,
	})
	if err != nil {
		return EngineTest{OK: false, Message: err.Error(), Sample: ""}
	}
	v, problem := k.Extract(res.Text)
	valid := problem == ""
	if valid {
		_, hasG := v.Get("greeting")
		_, hasR := v.Get("ready")
		valid = hasG && hasR
	}
	m.publish()
	return EngineTest{OK: true, TokensPerSecond: round1(res.TokensPerSecond), ValidJSON: valid, Sample: playkit.Clip(res.Text, 300)}
}
