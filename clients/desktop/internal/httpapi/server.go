// Package httpapi serves the Core API of clients/playkit/core-api.ts on 127.0.0.1, and the interface.
//
// Who may call it: only a page served by this program, in the browser this program opened. Enforced by
//   - binding 127.0.0.1 only;
//   - a random launch token per run, handed to the browser in the URL fragment. Every /core route needs either
//     `Authorization: Bearer <launch token>` or the session cookie that POST /core/session gives for that token
//     (HttpOnly, SameSite=Strict, Path=/, no expiry: it dies with the browser session, and its random id is
//     only known to this process, so a new run needs a new link). Tokens are compared in constant time;
//   - the Host header must be 127.0.0.1:<port> or localhost:<port> on every request (defeats DNS rebinding);
//   - a request carrying Origin must come from that same origin, and Sec-Fetch-Site, when sent, must be
//     same-origin or none; because a cookie is ambient, a state-changing request (POST, PUT, DELETE) authenticated
//     by the cookie must also carry Origin equal to this origin and a JSON content type;
//   - JSON bodies at most 64 KiB; no CORS headers are ever sent.
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/core"
)

// Server is the local HTTP server.
type Server struct {
	core  *core.Core
	token string
	port  int
	web   fs.FS
	srv   *http.Server
	ln    net.Listener

	mu       sync.Mutex
	sessions map[string]bool
}

const cookieName = "ajwf_session"

// NewToken returns 32 random bytes, base64url.
func NewToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Listen binds 127.0.0.1 on port (0 = a free one; 8080 is refused).
func Listen(c *core.Core, web fs.FS, port int) (*Server, error) {
	if port == 8080 {
		return nil, errors.New("port 8080 is reserved on this machine; choose another")
	}
	var ln net.Listener
	var err error
	for i := 0; i < 5; i++ {
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		if ln.Addr().(*net.TCPAddr).Port != 8080 {
			break
		}
		ln.Close()
	}
	s := &Server{core: c, token: NewToken(), port: ln.Addr().(*net.TCPAddr).Port, web: web, ln: ln, sessions: map[string]bool{}}
	s.srv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	return s, nil
}

// Port and Token for building the URL that opens the interface.
func (s *Server) Port() int      { return s.port }
func (s *Server) Token() string  { return s.token }
func (s *Server) URL() string    { return "http://127.0.0.1:" + strconv.Itoa(s.port) + "/#token=" + s.token }
func (s *Server) Origin() string { return "http://127.0.0.1:" + strconv.Itoa(s.port) }

// Serve blocks until Shutdown.
func (s *Server) Serve() error {
	err := s.srv.Serve(s.ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }

func (s *Server) allowedHost(h string) bool {
	p := strconv.Itoa(s.port)
	return h == "127.0.0.1:"+p || h == "localhost:"+p
}

func (s *Server) allowedOrigin(o string) bool {
	p := strconv.Itoa(s.port)
	return o == "http://127.0.0.1:"+p || o == "http://localhost:"+p
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var ce *core.Error
	if errors.As(err, &ce) {
		writeJSON(w, ce.Status, map[string]any{"error": map[string]string{"code": ce.Code, "message": ce.Message}})
		return
	}
	writeJSON(w, 500, map[string]any{"error": map[string]string{"code": "INTERNAL", "message": err.Error()}})
}

func fail(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// guard applies the Host, origin and token checks.
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if !s.allowedHost(r.Host) {
			fail(w, http.StatusMisdirectedRequest, "BAD_HOST", "unexpected Host header")
			return
		}
		isCore := strings.HasPrefix(r.URL.Path, "/core/") || r.URL.Path == "/core"
		// A link clicked on another site may open the interface (a GET navigation of a static file): the page holds
		// no secret, and every /core route stays guarded (the SameSite=Strict cookie does not come along).
		staticNav := !isCore && (r.Method == http.MethodGet || r.Method == http.MethodHead)
		if o := r.Header.Get("Origin"); o != "" && !s.allowedOrigin(o) && !staticNav {
			fail(w, http.StatusForbidden, "CROSS_ORIGIN", "cross-origin requests are refused")
			return
		}
		if sf := r.Header.Get("Sec-Fetch-Site"); sf != "" && sf != "same-origin" && sf != "none" && !staticNav {
			fail(w, http.StatusForbidden, "CROSS_ORIGIN", "cross-site requests are refused")
			return
		}
		if isCore {
			h.Set("Cache-Control", "no-store")
			changing := r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodDelete
			ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
			byCookie := false
			if r.URL.Path == "/core/session" {
				// Exchanging the launch token for a cookie: same-origin page only.
				if r.Method != http.MethodPost || !s.allowedOrigin(r.Header.Get("Origin")) || ct != "application/json" {
					fail(w, http.StatusForbidden, "unauthorized", "the session must be opened by the page itself")
					return
				}
			} else {
				tok := ""
				if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
					tok = strings.TrimPrefix(a, "Bearer ")
				}
				switch {
				case tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(s.token)) == 1:
				case tok == "" && s.validCookie(r):
					byCookie = true
				default:
					fail(w, http.StatusUnauthorized, "unauthorized", "missing or wrong session")
					return
				}
			}
			if byCookie && changing && (!s.allowedOrigin(r.Header.Get("Origin")) || ct != "application/json") {
				fail(w, http.StatusForbidden, "unauthorized", "state-changing requests need this page's Origin and a JSON content type")
				return
			}
			if changing {
				if r.ContentLength > 0 && ct != "application/json" {
					fail(w, http.StatusUnsupportedMediaType, "BAD_REQUEST", "send JSON")
					return
				}
				r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) validCookie(r *http.Request) bool {
	ck, err := r.Cookie(cookieName)
	if err != nil || ck.Value == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[ck.Value]
}

// session exchanges the launch token for the session cookie.
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := decode(r, &body); err != nil || subtle.ConstantTimeCompare([]byte(body.Token), []byte(s.token)) != 1 {
		fail(w, http.StatusUnauthorized, "unauthorized", "wrong token: open the link the program printed, or run `ajwf-player open`")
		return
	}
	id := NewToken()
	s.mu.Lock()
	s.sessions[id] = true
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: id, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return &core.Error{Status: 400, Code: "BAD_REQUEST", Message: "invalid JSON body"}
	}
	return nil
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	c := s.core
	mux.HandleFunc("POST /core/session", s.session)
	mux.HandleFunc("GET /core/state", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.State()) })
	mux.HandleFunc("GET /core/events", s.events)
	mux.HandleFunc("GET /core/appearance/options", func(w http.ResponseWriter, r *http.Request) {
		o, err := c.AppearanceOptions(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, o)
	})
	mux.HandleFunc("POST /core/characters", func(w http.ResponseWriter, r *http.Request) {
		var raw struct {
			core.NewCharacter
			Appearance json.RawMessage `json:"appearance"`
		}
		if err := decode(r, &raw); err != nil {
			writeErr(w, err)
			return
		}
		in := raw.NewCharacter
		var surprise string
		var choice core.AppearanceChoice
		switch {
		case len(raw.Appearance) == 0 || string(raw.Appearance) == "null":
			in.Appearance = "surprise_me"
		case json.Unmarshal(raw.Appearance, &surprise) == nil:
			if surprise != "surprise_me" {
				fail(w, 400, "INVALID", "appearance must be surprise_me or a choice")
				return
			}
			in.Appearance = surprise
		case json.Unmarshal(raw.Appearance, &choice) == nil && choice.OptionsToken != "" && len(choice.Choice) > 0:
			in.Appearance = choice
		default:
			fail(w, 400, "INVALID", "appearance must be surprise_me or {optionsToken, choice}")
			return
		}
		sum, err := c.CreateCharacter(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, sum)
	})
	mux.HandleFunc("GET /core/characters/{id}", func(w http.ResponseWriter, r *http.Request) {
		d, err := c.Character(r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, d)
	})
	mux.HandleFunc("POST /core/characters/{id}/seen", func(w http.ResponseWriter, r *http.Request) {
		sum, err := c.Seen(r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, sum)
	})
	mux.HandleFunc("GET /core/characters/{id}/claim", func(w http.ResponseWriter, r *http.Request) {
		u, err := c.ClaimLink(r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		var out *string
		if u != "" {
			out = &u
		}
		writeJSON(w, 200, map[string]*string{"url": out})
	})
	mux.HandleFunc("GET /core/characters/{id}/log", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		l, err := c.Log(r.PathValue("id"), r.URL.Query().Get("before"), limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, l)
	})
	mux.HandleFunc("POST /core/characters/{id}/control", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Run *bool `json:"run"`
		}
		if err := decode(r, &body); err != nil || body.Run == nil {
			fail(w, 400, "INVALID", "body must be {run: boolean}")
			return
		}
		sum, err := c.Control(r.PathValue("id"), *body.Run)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, sum)
	})
	mux.HandleFunc("PUT /core/characters/{id}/directives", func(w http.ResponseWriter, r *http.Request) {
		var d core.Directives
		if err := decode(r, &d); err != nil {
			writeErr(w, err)
			return
		}
		out, err := c.SetDirectives(r.PathValue("id"), d)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	})
	mux.HandleFunc("POST /core/characters/{id}/command", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text string `json:"text"`
		}
		if err := decode(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if err := c.Command(r.PathValue("id"), body.Text); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /core/characters/{id}/chat", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Text string `json:"text"`
		}
		if err := decode(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		m, err := c.Chat(r.Context(), r.PathValue("id"), body.Text)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, m)
	})
	mux.HandleFunc("GET /core/characters/{id}/chat", func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		m, err := c.ChatHistory(r.PathValue("id"), limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, m)
	})
	mux.HandleFunc("DELETE /core/characters/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Forget(r.PathValue("id")); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /core/settings", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.Settings()) })
	mux.HandleFunc("PUT /core/settings", func(w http.ResponseWriter, r *http.Request) {
		var patch map[string]json.RawMessage
		if err := decode(r, &patch); err != nil {
			writeErr(w, err)
			return
		}
		st, err := c.SetSettings(patch)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, st)
	})
	mux.HandleFunc("GET /core/engine", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.EngineState()) })
	mux.HandleFunc("GET /core/engine/providers", func(w http.ResponseWriter, r *http.Request) {
		if u := r.URL.Query().Get("url"); u != "" {
			p, err := c.ProbeURL(r.Context(), u)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, p)
			return
		}
		writeJSON(w, 200, c.Providers(r.Context()))
	})
	mux.HandleFunc("PUT /core/engine", func(w http.ResponseWriter, r *http.Request) {
		var ch core.EngineChoice
		if err := decode(r, &ch); err != nil {
			writeErr(w, err)
			return
		}
		st, err := c.SetEngine(ch)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, st)
	})
	mux.HandleFunc("POST /core/engine/download", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.StartDownload()) })
	mux.HandleFunc("POST /core/engine/download/pause", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.PauseDownload()) })
	mux.HandleFunc("DELETE /core/engine/download", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.CancelDownload()) })
	mux.HandleFunc("POST /core/engine/test", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.TestEngine(r.Context())) })
	mux.HandleFunc("/core/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "NOT_FOUND", "no such route") })
	mux.HandleFunc("/", s.static)
	return s.guard(mux)
}

// events streams CoreEvents as Server-Sent Events, each flushed, with a `: keepalive` comment every 15 s.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		fail(w, 500, "INTERNAL", "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)
	ch, stop := s.core.Subscribe()
	defer stop()
	_, _ = io.WriteString(w, ": connected\n\n")
	fl.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = io.WriteString(w, ": keepalive\n\n")
			fl.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			_, _ = io.WriteString(w, "data: "+string(b)+"\n\n")
			fl.Flush()
		}
	}
}

// static serves the embedded interface, a single-page app: a file that exists is served; a missing one under
// /_expo/ or /assets/ is a 404; any other path gets index.html (client-side routes). The page carries its own CSP.
func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		fail(w, 405, "METHOD", "method not allowed")
		return
	}
	p := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if st, err := fs.Stat(s.web, p); err != nil || st.IsDir() {
		if strings.HasPrefix(p, "_expo/") || strings.HasPrefix(p, "assets/") {
			http.NotFound(w, r)
			return
		}
		p = "index.html"
	}
	b, err := fs.ReadFile(s.web, p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	ct := mime.TypeByExtension(path.Ext(p))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	if p == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	_, _ = w.Write(b)
}
