package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/core"
)

func newServer(t *testing.T) *Server {
	t.Helper()
	c, err := core.New(core.Options{DataDir: t.TempDir(), CacheDir: t.TempDir(), SecretsMode: "file", Server: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	web := fstest.MapFS{"index.html": {Data: []byte("<!doctype html>app")}, "_expo/static/js/a.js": {Data: []byte("js")}}
	s, err := Listen(c, web, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.ln.Close() })
	return s
}

func do(s *Server, method, path, host string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, path, rd)
	r.Host = host
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.srv.Handler.ServeHTTP(w, r)
	return w
}

func TestGuard(t *testing.T) {
	s := newServer(t)
	host := "127.0.0.1:" + strconv.Itoa(s.port)
	origin := "http://" + host
	bearer := map[string]string{"Authorization": "Bearer " + s.token}

	// DNS rebinding: any other Host is refused, even with the right token.
	if w := do(s, "GET", "/core/state", "evil.example:"+strconv.Itoa(s.port), bearer, ""); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("foreign host: %d", w.Code)
	}
	if w := do(s, "GET", "/", "evil.example", nil, ""); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("foreign host on a page: %d", w.Code)
	}
	// No token, wrong token: 401.
	if w := do(s, "GET", "/core/state", host, nil, ""); w.Code != 401 || !strings.Contains(w.Body.String(), `"unauthorized"`) {
		t.Fatalf("no token: %d %s", w.Code, w.Body)
	}
	if w := do(s, "GET", "/core/state", host, map[string]string{"Authorization": "Bearer nope"}, ""); w.Code != 401 {
		t.Fatalf("wrong token: %d", w.Code)
	}
	// The token in a query string is not accepted.
	if w := do(s, "GET", "/core/events?token="+s.token, host, nil, ""); w.Code != 401 {
		t.Fatalf("query token: %d", w.Code)
	}
	if w := do(s, "GET", "/core/state", host, bearer, ""); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("bearer: %d %v", w.Code, w.Header())
	}
	// Cross-origin: refused before the token matters.
	if w := do(s, "GET", "/core/state", host, map[string]string{"Authorization": "Bearer " + s.token, "Origin": "https://evil.example"}, ""); w.Code != 403 {
		t.Fatalf("cross origin: %d", w.Code)
	}
	if w := do(s, "GET", "/core/state", host, map[string]string{"Authorization": "Bearer " + s.token, "Sec-Fetch-Site": "cross-site"}, ""); w.Code != 403 {
		t.Fatalf("cross site: %d", w.Code)
	}

	// The session cookie: only for the launch token, only from this origin, with JSON.
	tok := `{"token":"` + s.token + `"}`
	if w := do(s, "POST", "/core/session", host, map[string]string{"Content-Type": "application/json"}, tok); w.Code != 403 {
		t.Fatalf("session without origin: %d", w.Code)
	}
	if w := do(s, "POST", "/core/session", host, map[string]string{"Content-Type": "application/json", "Origin": origin}, `{"token":"nope"}`); w.Code != 401 {
		t.Fatalf("session with a wrong token: %d", w.Code)
	}
	w := do(s, "POST", "/core/session", host, map[string]string{"Content-Type": "application/json", "Origin": origin}, tok)
	if w.Code != 200 {
		t.Fatalf("session: %d %s", w.Code, w.Body)
	}
	ck := w.Result().Cookies()
	if len(ck) != 1 || !ck[0].HttpOnly || ck[0].SameSite != http.SameSiteStrictMode || ck[0].Path != "/" || ck[0].Value == s.token || ck[0].MaxAge != 0 || !ck[0].Expires.IsZero() {
		t.Fatalf("cookie: %+v", ck)
	}
	cookie := map[string]string{"Cookie": ck[0].Name + "=" + ck[0].Value}
	if w := do(s, "GET", "/core/state", host, cookie, ""); w.Code != 200 {
		t.Fatalf("cookie read: %d", w.Code)
	}
	if w := do(s, "GET", "/core/state", host, map[string]string{"Cookie": ck[0].Name + "=forged"}, ""); w.Code != 401 {
		t.Fatalf("forged cookie: %d", w.Code)
	}
	// With the cookie, changing state needs this Origin and JSON.
	body := `{"serverUrl":"http://127.0.0.1:2"}`
	if w := do(s, "PUT", "/core/settings", host, map[string]string{"Cookie": cookie["Cookie"], "Content-Type": "application/json"}, body); w.Code != 403 {
		t.Fatalf("cookie write without origin: %d", w.Code)
	}
	if w := do(s, "PUT", "/core/settings", host, map[string]string{"Cookie": cookie["Cookie"], "Origin": origin, "Content-Type": "text/plain"}, body); w.Code != 403 {
		t.Fatalf("cookie write as text/plain: %d", w.Code)
	}
	if w := do(s, "PUT", "/core/settings", host, map[string]string{"Cookie": cookie["Cookie"], "Origin": origin, "Content-Type": "application/json"}, body); w.Code != 200 {
		t.Fatalf("cookie write: %d %s", w.Code, w.Body)
	}
	if w := do(s, "PUT", "/core/settings", host, map[string]string{"Cookie": cookie["Cookie"], "Origin": origin, "Content-Type": "application/json"}, `{"serverUrl":"ftp://x"}`); w.Code != 400 || !strings.Contains(w.Body.String(), "INVALID_URL") {
		t.Fatalf("bad url: %d %s", w.Code, w.Body)
	}
	// Typed-address probe validates the URL.
	if w := do(s, "GET", "/core/engine/providers?url=file:///etc/passwd", host, bearer, ""); w.Code != 400 || !strings.Contains(w.Body.String(), "INVALID_URL") {
		t.Fatalf("probe url: %d %s", w.Code, w.Body)
	}

	// The single-page app: real files, 404 under /_expo/ and /assets/, index.html elsewhere; no CSP header.
	if w := do(s, "GET", "/_expo/static/js/a.js", host, nil, ""); w.Code != 200 || w.Body.String() != "js" {
		t.Fatalf("asset: %d", w.Code)
	}
	if w := do(s, "GET", "/_expo/missing.js", host, nil, ""); w.Code != 404 {
		t.Fatalf("missing asset: %d", w.Code)
	}
	if w := do(s, "GET", "/characters/abc", host, nil, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "app") || w.Header().Get("Content-Security-Policy") != "" {
		t.Fatalf("spa route: %d %v", w.Code, w.Header())
	}
}

func TestListenRefuses8080(t *testing.T) {
	if _, err := Listen(nil, nil, 8080); err == nil {
		t.Fatal("8080 accepted")
	}
}

func TestCrossSiteNavigationGetsThePageOnly(t *testing.T) {
	s := newServer(t)
	host := "127.0.0.1:" + strconv.Itoa(s.port)
	origin := "http://" + host
	cross := map[string]string{"Sec-Fetch-Site": "cross-site"}
	// A link on another site opens the interface: the page (no secret in it).
	if w := do(s, "GET", "/", host, cross, ""); w.Code != 200 || !strings.Contains(w.Body.String(), "app") {
		t.Fatalf("cross-site navigation: %d", w.Code)
	}
	// Get a session cookie the legitimate way, then try to use it cross-site: refused on every /core route.
	w := do(s, "POST", "/core/session", host, map[string]string{"Content-Type": "application/json", "Origin": origin}, `{"token":"`+s.token+`"}`)
	ck := w.Result().Cookies()[0]
	withCookie := map[string]string{"Cookie": ck.Name + "=" + ck.Value, "Sec-Fetch-Site": "cross-site"}
	for _, path := range []string{"/core/state", "/core/events", "/core/characters/x/claim"} {
		if w := do(s, "GET", path, host, withCookie, ""); w.Code != 403 {
			t.Fatalf("cross-site %s: %d", path, w.Code)
		}
	}
	// A cross-site POST, even to a static path, and a foreign Origin on /core: refused.
	if w := do(s, "POST", "/", host, cross, "x"); w.Code != 403 {
		t.Fatalf("cross-site POST: %d", w.Code)
	}
	if w := do(s, "GET", "/core/state", host, map[string]string{"Cookie": ck.Name + "=" + ck.Value, "Origin": "https://evil.example"}, ""); w.Code != 403 {
		t.Fatalf("foreign origin on /core: %d", w.Code)
	}
	// The Host check still applies to the page.
	if w := do(s, "GET", "/", "evil.example", cross, ""); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("foreign host: %d", w.Code)
	}
}
