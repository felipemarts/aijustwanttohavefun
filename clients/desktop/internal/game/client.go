// Package game is a client for the game's agent API (public-docs/skill.md). The agent API key is sent only to the
// server the agent registered on, never follows a redirect, and never appears in an error or a log.
package game

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// HTTPError is a transport-level failure: a status other than 200, or a 429.
type HTTPError struct {
	Status     int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *HTTPError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("game server: HTTP %d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("game server: HTTP %d", e.Status)
}

// IsUnauthorized reports a refused key.
func IsUnauthorized(err error) bool {
	var he *HTTPError
	return errors.As(err, &he) && he.Status == http.StatusUnauthorized
}

// RetryAfter returns how long a 429 asks to wait.
func RetryAfter(err error) (time.Duration, bool) {
	var he *HTTPError
	if errors.As(err, &he) && he.Status == http.StatusTooManyRequests {
		return he.RetryAfter, true
	}
	return 0, false
}

var plain = &http.Client{
	Timeout:       30 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// NormalizeServer checks a game server URL (http or https, no credentials, no query) and trims the trailing slash.
func NormalizeServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("not a valid game server URL: %q", raw)
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

// limiter is a token bucket per key: perMinute requests a minute, bursting to the same number.
type limiter struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	rate   float64 // per second
	burst  float64
	// until: a 429 pauses every request of this key.
	until time.Time
}

func (l *limiter) wait(ctx context.Context) error {
	for {
		l.mu.Lock()
		now := time.Now()
		if now.Before(l.until) {
			d := l.until.Sub(now)
			l.mu.Unlock()
			if err := sleep(ctx, d); err != nil {
				return err
			}
			continue
		}
		l.tokens += now.Sub(l.last).Seconds() * l.rate
		if l.tokens > l.burst {
			l.tokens = l.burst
		}
		l.last = now
		if l.tokens >= 1 {
			l.tokens--
			l.mu.Unlock()
			return nil
		}
		d := time.Duration((1 - l.tokens) / l.rate * float64(time.Second))
		l.mu.Unlock()
		if err := sleep(ctx, d); err != nil {
			return err
		}
	}
}

func (l *limiter) pause(d time.Duration) {
	l.mu.Lock()
	if t := time.Now().Add(d); t.After(l.until) {
		l.until = t
	}
	l.mu.Unlock()
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Client plays one agent.
type Client struct {
	Base string
	key  string
	lim  *limiter
	// MaxRetryAfter caps how long one 429 may pause the key.
	MaxRetryAfter time.Duration
}

// NewClient makes a client for an agent key on its server, limited to perMinute requests a minute.
func NewClient(base, key string, perMinute int) *Client {
	r := float64(perMinute) / 60
	return &Client{Base: base, key: key, lim: &limiter{tokens: 5, last: time.Now(), rate: r, burst: 5}, MaxRetryAfter: 5 * time.Minute}
}

func (c *Client) do(ctx context.Context, method, path string, body any, headers map[string]string) (jv.Value, error) {
	if err := c.lim.wait(ctx); err != nil {
		return jv.Value{}, err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return jv.Value{}, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+"/api/v1"+path, rd)
	if err != nil {
		return jv.Value{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("User-Agent", "ajwf-player")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := plain.Do(req)
	if err != nil {
		// The URL carries no secret; the error is safe to show.
		return jv.Value{}, fmt.Errorf("game server unreachable: %w", errors.Unwrap(err))
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return jv.Value{}, err
	}
	if resp.StatusCode != http.StatusOK {
		he := &HTTPError{Status: resp.StatusCode}
		if v, err := jv.ParseBytes(raw); err == nil {
			e, _ := v.Get("error")
			code, _ := e.Get("code")
			msg, _ := e.Get("message")
			he.Code, he.Message = code.Text(), msg.Text()
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			secs, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
			if secs <= 0 {
				secs = 5
			}
			he.RetryAfter = time.Duration(secs) * time.Second
			if he.RetryAfter > c.MaxRetryAfter {
				he.RetryAfter = c.MaxRetryAfter
			}
			c.lim.pause(he.RetryAfter)
		}
		return jv.Value{}, he
	}
	v, err := jv.ParseBytes(raw)
	if err != nil {
		return jv.Value{}, fmt.Errorf("game server sent invalid JSON")
	}
	return v, nil
}

// withRetry repeats a call after a 429 (waiting Retry-After) or a network error, up to 3 attempts.
func (c *Client) withRetry(ctx context.Context, f func() (jv.Value, error)) (jv.Value, error) {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		v, err := f()
		if err == nil {
			return v, nil
		}
		last = err
		var he *HTTPError
		if errors.As(err, &he) && he.Status != http.StatusTooManyRequests && he.Status < 500 {
			return jv.Value{}, err
		}
		if ctx.Err() != nil {
			return jv.Value{}, ctx.Err()
		}
		if _, ok := RetryAfter(err); !ok {
			if err := sleep(ctx, time.Duration(attempt+1)*2*time.Second); err != nil {
				return jv.Value{}, err
			}
		}
	}
	return jv.Value{}, last
}

func (c *Client) Look(ctx context.Context) (jv.Value, error) {
	return c.withRetry(ctx, func() (jv.Value, error) { return c.do(ctx, http.MethodGet, "/look", nil, nil) })
}

func (c *Client) Me(ctx context.Context) (jv.Value, error) {
	return c.withRetry(ctx, func() (jv.Value, error) { return c.do(ctx, http.MethodGet, "/me", nil, nil) })
}

func (c *Client) Events(ctx context.Context, since string) (jv.Value, error) {
	if since == "" {
		since = "0"
	}
	return c.withRetry(ctx, func() (jv.Value, error) {
		return c.do(ctx, http.MethodGet, "/events?since="+url.QueryEscape(since), nil, nil)
	})
}

// Act sends one action with an idempotency key, so a retry after a timeout cannot act twice. The body is returned
// whether the game applied the action (`ok: true`) or refused it (`ok: false`).
func (c *Client) Act(ctx context.Context, action string, params jv.Value) (jv.Value, error) {
	if params.Kind != jv.Object {
		params = jv.Obj()
	}
	idem := NewID()
	body := map[string]any{"action": action, "params": params}
	return c.withRetry(ctx, func() (jv.Value, error) {
		return c.do(ctx, http.MethodPost, "/act", body, map[string]string{"Idempotency-Key": idem})
	})
}

// NewID returns 16 random bytes in hex.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ── Unauthenticated routes ───────────────────────────────────────────────────────────────────────────────────────

func get(ctx context.Context, u string, headers map[string]string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("User-Agent", "ajwf-player")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := plain.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("game server unreachable: %w", errors.Unwrap(err))
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return resp, b, err
}

// Schema fetches GET /api/v1/schema; with etag set, a 304 returns notModified.
func Schema(ctx context.Context, base, etag string) (body string, newEtag string, notModified bool, err error) {
	h := map[string]string{}
	if etag != "" {
		h["If-None-Match"] = etag
	}
	resp, b, err := get(ctx, base+"/api/v1/schema", h)
	if err != nil {
		return "", "", false, err
	}
	switch resp.StatusCode {
	case http.StatusNotModified:
		return "", etag, true, nil
	case http.StatusOK:
		return string(b), resp.Header.Get("ETag"), false, nil
	}
	return "", "", false, &HTTPError{Status: resp.StatusCode}
}

// Help fetches GET /api/v1/help (to check that the server answers, and its skill_version).
func Help(ctx context.Context, base string) (jv.Value, error) {
	resp, b, err := get(ctx, base+"/api/v1/help", nil)
	if err != nil {
		return jv.Value{}, err
	}
	if resp.StatusCode != 200 {
		return jv.Value{}, &HTTPError{Status: resp.StatusCode}
	}
	return jv.ParseBytes(b)
}

// AppearanceOptions fetches GET /api/v1/appearance/options in a language.
func AppearanceOptions(ctx context.Context, base, lang string) (jv.Value, error) {
	resp, b, err := get(ctx, base+"/api/v1/appearance/options?lang="+url.QueryEscape(lang), nil)
	if err != nil {
		return jv.Value{}, err
	}
	if resp.StatusCode != 200 {
		return jv.Value{}, &HTTPError{Status: resp.StatusCode}
	}
	return jv.ParseBytes(b)
}

// PublicAgent fetches GET /api/v1/agents/<name>.
func PublicAgent(ctx context.Context, base, name string) (jv.Value, error) {
	resp, b, err := get(ctx, base+"/api/v1/agents/"+url.PathEscape(name), nil)
	if err != nil {
		return jv.Value{}, err
	}
	if resp.StatusCode != 200 {
		return jv.Value{}, &HTTPError{Status: resp.StatusCode}
	}
	return jv.ParseBytes(b)
}

// Registration is what POST /agents/register returns that the client keeps.
type Registration struct {
	Name     string
	Class    string
	Language string
	APIKey   string
	ClaimURL string
}

// Register creates an agent. The body is sent as given (name, class, language, appearance, options_token).
func Register(ctx context.Context, base string, body map[string]any) (Registration, jv.Value, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/agents/register", bytes.NewReader(b))
	if err != nil {
		return Registration{}, jv.Value{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ajwf-player")
	resp, err := plain.Do(req)
	if err != nil {
		return Registration{}, jv.Value{}, fmt.Errorf("game server unreachable: %w", errors.Unwrap(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	v, err := jv.ParseBytes(raw)
	if err != nil {
		return Registration{}, jv.Value{}, &HTTPError{Status: resp.StatusCode}
	}
	if ok, _ := v.Get("ok"); !(ok.Kind == jv.Bool && ok.B) {
		e, _ := v.Get("error")
		code, _ := e.Get("code")
		msg, _ := e.Get("message")
		return Registration{}, v, &HTTPError{Status: resp.StatusCode, Code: code.Text(), Message: msg.Text()}
	}
	agent, _ := v.Get("agent")
	key, _ := v.Get("api_key")
	claim, _ := v.Get("claim_url")
	name, _ := agent.Get("name")
	cls, _ := agent.Get("class")
	lang, _ := agent.Get("language")
	if key.Text() == "" {
		return Registration{}, v, errors.New("register: no api_key in the answer")
	}
	return Registration{Name: name.Text(), Class: cls.Text(), Language: lang.Text(), APIKey: key.Text(), ClaimURL: claim.Text()}, v, nil
}

// PublicWorld fetches GET /api/public/world (the spectator map: every room's zone, flags and exits).
func PublicWorld(ctx context.Context, base string) (string, error) {
	resp, b, err := get(ctx, base+"/api/public/world", nil)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != 200 {
		return "", &HTTPError{Status: resp.StatusCode}
	}
	return string(b), nil
}

// PublicRoom fetches GET /api/public/rooms/<id> (live monsters with levels, NPCs, resources).
func PublicRoom(ctx context.Context, base, id string) (jv.Value, error) {
	resp, b, err := get(ctx, base+"/api/public/rooms/"+url.PathEscape(id), nil)
	if err != nil {
		return jv.Value{}, err
	}
	if resp.StatusCode != 200 {
		return jv.Value{}, &HTTPError{Status: resp.StatusCode}
	}
	return jv.ParseBytes(b)
}
