package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

func engineCore(t *testing.T, h http.HandlerFunc) *Core {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(Options{DataDir: t.TempDir(), CacheDir: t.TempDir(), SecretsMode: "file", Server: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	c.eng.mu.Lock()
	c.eng.choice = engineFile{Kind: "openai", URL: srv.URL}
	c.eng.provider = &engine.OpenAI{Base: srv.URL}
	c.eng.status = "ready"
	c.eng.mu.Unlock()
	return c
}

func req() engine.Request {
	return engine.Request{Messages: []playkit.Message{{Role: "user", Content: "hi"}}, MaxTokens: 10}
}

func TestStalledEngineTimesOut(t *testing.T) {
	c := engineCore(t, func(w http.ResponseWriter, r *http.Request) { time.Sleep(3 * time.Second) })
	c.kit.Engine.TimeoutBaseSeconds, c.kit.Engine.FloorTokensPerSecond = 1, 1000
	start := time.Now()
	_, err := c.eng.infer(context.Background(), req())
	if !errors.Is(err, ErrTimeout) || time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("err %v after %s", err, time.Since(start))
	}
	if st := c.eng.state(); st.Status != "error" || st.Message != c.tr("eng_timeout") {
		t.Fatalf("state %+v", st)
	}
}

func TestEngineErrorShowsNoRawBody(t *testing.T) {
	c := engineCore(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":"RAW-INTERNAL-DETAIL"}`))
	})
	if _, err := c.eng.infer(context.Background(), req()); err == nil {
		t.Fatal("no error")
	}
	st := c.eng.state()
	if st.Status != "error" || strings.Contains(st.Message, "RAW-INTERNAL-DETAIL") || st.Message != c.tr("eng_failed") {
		t.Fatalf("state %+v", st)
	}
}

func TestRequestTimeoutFromBudget(t *testing.T) {
	c := engineCore(t, func(w http.ResponseWriter, r *http.Request) {})
	c.kit.Engine.TimeoutBaseSeconds, c.kit.Engine.FloorTokensPerSecond = 60, 2
	if d := c.eng.requestTimeout(320); d != 220*time.Second {
		t.Fatalf("%s", d)
	}
}
