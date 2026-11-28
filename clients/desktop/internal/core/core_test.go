package core

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

const secretKey = "ajwf_sk_TOPSECRETvalue123"

func TestKeyAndClaimLinkStayPrivate(t *testing.T) {
	var gotBio string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agents/register":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotBio, _ = body["bio"].(string)
			_, _ = w.Write([]byte(`{"ok":true,"agent":{"name":"Pip","class":"mage","language":"en"},"api_key":"` + secretKey + `","claim_url":"http://game/claim/CLAIMTOKEN"}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true,"agent":{"sprite":"/sprites/ab.png"}}`))
		}
	}))
	defer srv.Close()
	data := t.TempDir()
	c, err := New(Options{DataDir: data, CacheDir: t.TempDir(), SecretsMode: "file", Server: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	events, stop := c.Subscribe()
	defer stop()
	sum, err := c.CreateCharacter(context.Background(), NewCharacter{Name: "Pip", Class: "mage", Language: "en", Persona: "PRIVATE persona", Bio: "Public bio", Appearance: "surprise_me"})
	if err != nil {
		t.Fatal(err)
	}
	if gotBio != "Public bio" {
		t.Fatalf("bio sent: %q (the persona must never be sent)", gotBio)
	}
	if !sum.ClaimPending {
		t.Fatal("claim not pending")
	}
	state, _ := json.Marshal(c.State())
	var evs []byte
	for len(events) > 0 {
		b, _ := json.Marshal(<-events)
		evs = append(evs, b...)
	}
	for what, b := range map[string][]byte{"state": state, "events": evs} {
		if strings.Contains(string(b), secretKey) || strings.Contains(string(b), "CLAIMTOKEN") {
			t.Fatalf("%s carries the key or the claim link: %s", what, b)
		}
	}
	if u, _ := c.ClaimLink(sum.ID); u != "http://game/claim/CLAIMTOKEN" {
		t.Fatalf("claim link: %q", u)
	}
	// On disk: the key only in the secrets file (file mode), 0600; nowhere else.
	_ = filepath.Walk(data, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s has mode %v", p, info.Mode().Perm())
		}
		b, _ := os.ReadFile(p)
		if strings.Contains(string(b), secretKey) && filepath.Base(p) != "secrets.json" {
			t.Errorf("%s contains the key", p)
		}
		return nil
	})
	if k, err := c.secrets.Get("agent:" + sum.ID); err != nil || k != secretKey {
		t.Fatal("key not stored")
	}
}

func TestMergeObsAndXP(t *testing.T) {
	prev, _ := jv.Parse(`{"you":{"lvl":1,"xp":[90,100]},"room":{"id":"a"},"pending":{"party":["X"]},"actions":["move"]}`)
	body, _ := jv.Parse(`{"you":{"lvl":2,"xp":[15,283]},"pending":{},"actions":["attack"]}`)
	m := mergeObs(prev, body, false)
	if jv.Canon(m) != `{"actions":["attack"],"pending":{},"room":{"id":"a"},"you":{"lvl":2,"xp":[15,283]}}` {
		t.Fatal(jv.Canon(m))
	}
	if g := xpGain(jvGet(prev, "you"), jvGet(body, "you")); g != 25 {
		t.Fatalf("xp gain %d", g)
	}
	if jv.Canon(mergeObs(prev, body, true)) != `{"actions":["attack"],"pending":{},"you":{"lvl":2,"xp":[15,283]}}` {
		t.Fatal("full replace")
	}
}
