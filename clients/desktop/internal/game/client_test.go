package game

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

func TestActRetriesAfter429WithTheSameIdempotencyKey(t *testing.T) {
	var calls int32
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keys = append(keys, r.Header.Get("Idempotency-Key"))
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(429)
			_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"RATE_LIMITED","message":"slow down"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"narration":"You walk north."}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ajwf_sk_secret", 600)
	start := time.Now()
	v, err := c.Act(context.Background(), "move", jv.Obj("dir", jv.Str("north")))
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := v.Get("narration"); n.S != "You walk north." {
		t.Fatal("bad body")
	}
	if time.Since(start) < 900*time.Millisecond {
		t.Fatal("Retry-After not honoured")
	}
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("idempotency keys: %v", keys)
	}
}

func TestNoRedirectAndKeyNeverInErrors(t *testing.T) {
	var leaked int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			atomic.StoreInt32(&leaked, 1)
		}
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ajwf_sk_secret", 600)
	_, err := c.Look(context.Background())
	if err == nil {
		t.Fatal("redirect followed as success")
	}
	if atomic.LoadInt32(&leaked) == 1 {
		t.Fatal("key sent to another host")
	}
	if strings.Contains(err.Error(), "ajwf_sk_secret") {
		t.Fatal("key in error")
	}
	if !IsUnauthorized(&HTTPError{Status: 401}) {
		t.Fatal("401")
	}
}

func TestNormalizeServer(t *testing.T) {
	if u, err := NormalizeServer("https://play.example/"); err != nil || u != "https://play.example" {
		t.Fatal(u, err)
	}
	for _, bad := range []string{"ftp://x", "https://u:p@x", "https://x/?a=1", "x"} {
		if _, err := NormalizeServer(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
