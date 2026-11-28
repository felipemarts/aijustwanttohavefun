package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/awake"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/game"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/store"
)

// Version of this client.
const Version = "0.1.0"

// DefaultServer is the game server used until the owner picks another.
const DefaultServer = "http://localhost:8710"

// Options configure a Core.
type Options struct {
	DataDir  string
	CacheDir string
	// SecretsMode: "auto", "keychain" or "file".
	SecretsMode string
	// Server overrides the stored game server URL when set.
	Server string
	// Trace records every turn's prompt, answer and result in trace.jsonl (no secrets are ever in them).
	Trace bool
	// Logf receives program log lines (never secrets).
	Logf func(string)
}

// Core is the desktop core.
type Core struct {
	opts    Options
	kit     *playkit.Kit
	store   *store.Store
	secrets store.Secrets
	eng     *engineMgr
	ctx     context.Context
	cancel  context.CancelFunc

	mu       sync.Mutex
	settings Settings
	chars    map[string]*character
	server   ServerState
	schemas  map[string]*schemaCache
	maps     map[string]*mapCache

	lang atomic.Value // interface language, read without locks

	subMu sync.Mutex
	subs  map[chan CoreEvent]struct{}

	wg      sync.WaitGroup
	started bool
	awake   awake.Keeper
}

type mapCache struct {
	m       *playkit.WorldMap
	fetched time.Time
}

// worldMap returns the public map of a server, fetched at most once an hour (nil when the server has none).
func (c *Core) worldMap(ctx context.Context, base string) *playkit.WorldMap {
	c.mu.Lock()
	mc := c.maps[base]
	c.mu.Unlock()
	if mc != nil && time.Since(mc.fetched) < time.Hour {
		return mc.m
	}
	body, err := game.PublicWorld(ctx, base)
	var m *playkit.WorldMap
	if err == nil {
		m, _ = playkit.ParseWorldMap(body)
	}
	if m == nil && mc != nil {
		m = mc.m
	}
	c.mu.Lock()
	c.maps[base] = &mapCache{m: m, fetched: time.Now()}
	c.mu.Unlock()
	return m
}

type schemaCache struct {
	doc     *playkit.SchemaDoc
	etag    string
	fetched time.Time
}

// New opens the data directory and loads everything. Call Start to begin playing.
func New(opts Options) (*Core, error) {
	st, err := store.Open(opts.DataDir)
	if err != nil {
		return nil, err
	}
	sec, err := store.OpenSecrets(opts.DataDir, opts.SecretsMode)
	if err != nil {
		return nil, err
	}
	kit, err := playkit.Load()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Core{opts: opts, kit: kit, store: st, secrets: sec, ctx: ctx, cancel: cancel,
		chars: map[string]*character{}, schemas: map[string]*schemaCache{}, maps: map[string]*mapCache{}, subs: map[chan CoreEvent]struct{}{}}
	c.settings = Settings{ServerURL: DefaultServer, Language: "en"}
	_ = st.Load("settings.json", &c.settings)
	if opts.Server != "" {
		u, err := game.NormalizeServer(opts.Server)
		if err != nil {
			return nil, err
		}
		c.settings.ServerURL = u
	}
	c.lang.Store(c.settings.Language)
	c.eng = newEngineMgr(c, opts.CacheDir)
	ids, err := st.CharacterIDs()
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		ch, err := c.loadCharacter(id)
		if err != nil {
			c.logf("character %s: %v", id, err)
			continue
		}
		c.chars[id] = ch
	}
	return c, nil
}

// SecretsKind says where keys are kept ("keychain" or "file").
func (c *Core) SecretsKind() string { return c.secrets.Kind() }

func (c *Core) logf(format string, a ...any) {
	if c.opts.Logf != nil {
		c.opts.Logf(fmt.Sprintf(format, a...))
	}
}

// Start begins the engine and the characters that are set to run.
func (c *Core) Start() {
	go func() {
		if c.eng.choice.Kind != "builtin" || c.eng.builtin.Status().State != "not_installed" {
			if _, err := c.eng.ensure(c.ctx); err != nil {
				c.logf("engine: %v", err)
			}
		}
		c.wakeAll()
	}()
	go c.watchServer()
	go c.keepAwakeLoop()
	c.mu.Lock()
	c.started = true
	for _, ch := range c.chars {
		c.startRunner(ch)
	}
	c.mu.Unlock()
}

// keepAwakeLoop holds the keep-awake while at least one character is set to run and the setting allows it
// (keepAwake defaults to true on desktop).
func (c *Core) keepAwakeLoop() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		c.mu.Lock()
		want := c.settings.KeepAwake == nil || *c.settings.KeepAwake
		running := false
		for _, ch := range c.chars {
			ch.mu.Lock()
			running = running || ch.rec.Run
			ch.mu.Unlock()
		}
		c.mu.Unlock()
		if want && running && !limitReached() {
			c.awake.Hold()
		} else {
			c.awake.Release()
		}
		select {
		case <-c.ctx.Done():
			c.awake.Release()
			return
		case <-t.C:
		}
	}
}

// Close stops every runner and the built-in engine.
func (c *Core) Close() {
	c.cancel()
	c.awake.Release()
	c.wg.Wait()
	c.eng.builtin.Stop()
	c.mu.Lock()
	for _, ch := range c.chars {
		ch.mu.Lock()
		_ = c.saveLocked(ch)
		ch.mu.Unlock()
	}
	c.mu.Unlock()
}

// EnginePID is the built-in llama-server's PID, or 0.
func (c *Core) EnginePID() int { return c.eng.builtin.PID() }

// ── events ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Subscribe returns a channel of events and a function that ends the subscription.
func (c *Core) Subscribe() (<-chan CoreEvent, func()) {
	ch := make(chan CoreEvent, 256)
	c.subMu.Lock()
	c.subs[ch] = struct{}{}
	c.subMu.Unlock()
	return ch, func() {
		c.subMu.Lock()
		if _, ok := c.subs[ch]; ok {
			delete(c.subs, ch)
			close(ch)
		}
		c.subMu.Unlock()
	}
}

func (c *Core) emit(ev CoreEvent) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- ev:
		default: // a slow listener drops events rather than stalling play
		}
	}
}

// ── settings and state ───────────────────────────────────────────────────────────────────────────────────────────

func (c *Core) Settings() Settings {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.settings
}

// SetSettings applies a partial update (fields present in the JSON patch).
func (c *Core) SetSettings(patch map[string]json.RawMessage) (Settings, error) {
	c.mu.Lock()
	s := c.settings
	c.mu.Unlock()
	if raw, ok := patch["serverUrl"]; ok {
		var u string
		if json.Unmarshal(raw, &u) != nil {
			return s, errf(400, "INVALID", "serverUrl must be a string")
		}
		n, err := game.NormalizeServer(u)
		if err != nil {
			return s, errf(400, "INVALID_URL", err.Error())
		}
		s.ServerURL = n
	}
	if raw, ok := patch["language"]; ok {
		var l string
		if json.Unmarshal(raw, &l) != nil || !langRe.MatchString(l) {
			return s, errf(400, "INVALID", "language must be a BCP-47 tag")
		}
		s.Language = l
	}
	if raw, ok := patch["keepAwake"]; ok {
		var b bool
		if json.Unmarshal(raw, &b) != nil {
			return s, errf(400, "INVALID", "keepAwake must be a boolean")
		}
		s.KeepAwake = &b
	}
	if err := c.store.Save("settings.json", s); err != nil {
		return s, errf(500, "STORE", err.Error())
	}
	c.mu.Lock()
	old := c.settings.Language
	c.settings = s
	chars := make([]*character, 0, len(c.chars))
	for _, ch := range c.chars {
		chars = append(chars, ch)
	}
	c.mu.Unlock()
	c.lang.Store(s.Language)
	if old != s.Language {
		// Summaries carry text in the interface language: send them again.
		for _, ch := range chars {
			c.changed(ch)
		}
		c.eng.publish()
	}
	go c.checkServer()
	return s, nil
}

var langRe = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$`)

func (c *Core) State() CoreState {
	c.mu.Lock()
	chars := make([]*character, 0, len(c.chars))
	for _, ch := range c.chars {
		chars = append(chars, ch)
	}
	settings, server := c.settings, c.server
	c.mu.Unlock()
	sort.Slice(chars, func(i, j int) bool { return chars[i].rec.CreatedAt < chars[j].rec.CreatedAt })
	sums := make([]CharacterSummary, 0, len(chars))
	for _, ch := range chars {
		sums = append(sums, c.summary(ch))
	}
	return CoreState{Version: Version, Playkit: c.kit.Version, Platform: "desktop", Settings: settings, Engine: c.eng.state(), Characters: sums, Server: server}
}

func (c *Core) watchServer() {
	for {
		c.checkServer()
		select {
		case <-c.ctx.Done():
			return
		case <-time.After(60 * time.Second):
		}
	}
}

func (c *Core) checkServer() {
	ctx, cancel := context.WithTimeout(c.ctx, 8*time.Second)
	defer cancel()
	base := c.Settings().ServerURL
	st := ServerState{}
	if h, err := game.Help(ctx, base); err == nil {
		st.Reachable = true
		sv, _ := h.Get("skill_version")
		st.SkillVersion = sv.Text()
	}
	c.mu.Lock()
	changed := c.server != st
	c.server = st
	c.mu.Unlock()
	if changed {
		c.emit(CoreEvent{Type: "server", Server: &st})
	}
}

// schemaFor returns the action schema document of a server, revalidated with its ETag at most every 10 minutes.
func (c *Core) schemaFor(ctx context.Context, base string) (*playkit.SchemaDoc, error) {
	c.mu.Lock()
	sc := c.schemas[base]
	c.mu.Unlock()
	if sc != nil && time.Since(sc.fetched) < 10*time.Minute {
		return sc.doc, nil
	}
	etag := ""
	if sc != nil {
		etag = sc.etag
	}
	body, newTag, notModified, err := game.Schema(ctx, base, etag)
	if err != nil {
		if sc != nil {
			return sc.doc, nil
		}
		return nil, err
	}
	if notModified && sc != nil {
		c.mu.Lock()
		sc.fetched = time.Now()
		c.mu.Unlock()
		return sc.doc, nil
	}
	doc, err := playkit.ParseSchemaDoc(body)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.schemas[base] = &schemaCache{doc: doc, etag: newTag, fetched: time.Now()}
	c.mu.Unlock()
	return doc, nil
}

// ── characters ───────────────────────────────────────────────────────────────────────────────────────────────────

func newLocalID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (c *Core) get(id string) (*character, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch, ok := c.chars[id]
	if !ok {
		return nil, errf(404, "NOT_FOUND", "no such character")
	}
	return ch, nil
}

// FindByName finds a character by local id or by name (case-insensitive), for the command line.
func (c *Core) FindByName(name string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.chars[name]; ok {
		return name, true
	}
	for id, ch := range c.chars {
		if strings.EqualFold(ch.rec.Name, name) {
			return id, true
		}
	}
	return "", false
}

var nameRe = regexp.MustCompile(`^[\p{L}\p{N}_-]{3,20}$`)

// AppearanceOptions proxies the game server's options in the interface language.
func (c *Core) AppearanceOptions(ctx context.Context) (AppearanceOptions, error) {
	s := c.Settings()
	v, err := game.AppearanceOptions(ctx, s.ServerURL, s.Language)
	if err != nil {
		return AppearanceOptions{}, errf(502, "network", "the game server did not answer")
	}
	out := AppearanceOptions{Options: map[string]map[string]string{}}
	tok, _ := v.Get("options_token")
	exp, _ := v.Get("expires_in")
	out.OptionsToken, out.ExpiresIn = tok.Text(), int(exp.N)
	opts, _ := v.Get("options")
	for _, layer := range opts.O {
		m := map[string]string{}
		for _, o := range layer.Val.O {
			m[o.Key] = o.Val.Text()
		}
		out.Options[layer.Key] = m
	}
	return out, nil
}

// CreateCharacter registers a new agent on the game server and keeps it on this device. The API key goes to the
// secret store; the claim link is kept for the owner and never shown to the model.
func (c *Core) CreateCharacter(ctx context.Context, in NewCharacter) (CharacterSummary, error) {
	in.Name = strings.TrimSpace(in.Name)
	if !nameRe.MatchString(in.Name) {
		return CharacterSummary{}, errf(400, "INVALID_NAME", "name: 3 to 20 letters, digits, _ or -")
	}
	switch in.Class {
	case "warrior", "mage", "rogue", "cleric":
	default:
		return CharacterSummary{}, errf(400, "INVALID", "class must be warrior, mage, rogue or cleric")
	}
	if in.Language == "" {
		in.Language = c.Settings().Language
	}
	if !langRe.MatchString(in.Language) {
		return CharacterSummary{}, errf(400, "INVALID", "language must be a BCP-47 tag")
	}
	pace := in.Pace
	if pace == "" {
		pace = "normal"
	}
	if _, ok := c.kit.Pace[pace]; !ok {
		return CharacterSummary{}, errf(400, "INVALID", "pace must be relaxed, normal or active")
	}
	in.Bio = strings.TrimSpace(in.Bio)
	if len([]rune(in.Bio)) > 300 {
		return CharacterSummary{}, errf(400, "INVALID", "bio: at most 300 characters")
	}
	body := map[string]any{"name": in.Name, "class": in.Class, "language": in.Language}
	if in.Bio != "" {
		body["bio"] = in.Bio
	}
	switch a := in.Appearance.(type) {
	case nil, string:
		body["appearance"] = "surprise_me"
	case AppearanceChoice:
		body["appearance"] = a.Choice
		body["options_token"] = a.OptionsToken
	default:
		return CharacterSummary{}, errf(400, "INVALID", "appearance must be surprise_me or a choice")
	}
	base := c.Settings().ServerURL
	reg, raw, err := game.Register(ctx, base, body)
	if err != nil {
		var he *game.HTTPError
		if errors.As(err, &he) && he.Code != "" {
			code := he.Code
			if code == "INVALID_PARAMS" && strings.Contains(strings.ToLower(he.Message), "name") {
				code = "INVALID_NAME"
			}
			return CharacterSummary{}, errf(409, code, he.Message)
		}
		return CharacterSummary{}, errf(502, "network", "the game server did not answer")
	}
	_ = raw
	id := newLocalID()
	if err := c.secrets.Set("agent:"+id, reg.APIKey); err != nil {
		return CharacterSummary{}, errf(500, "SECRETS", "could not store the agent key; the agent exists on the server as "+reg.Name)
	}
	rec := &record{
		ID: id, Name: reg.Name, Class: reg.Class, Language: reg.Language, ServerURL: base, ClaimURL: reg.ClaimURL, Bio: in.Bio,
		CreatedAt: time.Now().UnixMilli(), Run: true, // created running: the owner just pressed Create
		Directives: Directives{Persona: strings.TrimSpace(in.Persona), Wish: strings.TrimSpace(in.Wish), Pace: pace, AllowPvp: in.AllowPvp},
		Memory:     playkit.Memory{Notes: []string{}, Recent: []playkit.Recent{}, Chat: []playkit.ChatLine{}},
		Cursor:     "0",
		AwaySince:  time.Now().UnixMilli(),
	}
	if rec.Class == "" {
		rec.Class = in.Class
	}
	if rec.Language == "" {
		rec.Language = in.Language
	}
	ch := &character{rec: rec, wake: make(chan struct{}, 1)}
	if p, err := game.PublicAgent(ctx, base, reg.Name); err == nil {
		ag, _ := p.Get("agent")
		if s, _ := ag.Get("sprite"); s.Text() != "" {
			rec.Sprite = base + s.Text()
		}
	}
	c.mu.Lock()
	c.chars[id] = ch
	ch.mu.Lock()
	err = c.saveLocked(ch)
	ch.mu.Unlock()
	if c.started {
		c.startRunner(ch)
	}
	c.mu.Unlock()
	if err != nil {
		return CharacterSummary{}, errf(500, "STORE", err.Error())
	}
	c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("created", reg.Name)})
	sum := c.summary(ch)
	c.emit(CoreEvent{Type: "character", Character: &sum})
	return sum, nil
}

// Character returns the detail.
func (c *Core) Character(id string) (CharacterDetail, error) {
	ch, err := c.get(id)
	if err != nil {
		return CharacterDetail{}, err
	}
	return c.detail(ch), nil
}

// ClaimLink returns the claim link while the agent is unclaimed (it is never in summaries or events).
func (c *Core) ClaimLink(id string) (string, error) {
	ch, err := c.get(id)
	if err != nil {
		return "", err
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if ch.rec.Claimed {
		return "", nil
	}
	return ch.rec.ClaimURL, nil
}

// Seen clears the "while you were away" summary: the owner has looked.
func (c *Core) Seen(id string) (CharacterSummary, error) {
	ch, err := c.get(id)
	if err != nil {
		return CharacterSummary{}, err
	}
	ch.mu.Lock()
	ch.rec.Away = awayCounters{}
	ch.rec.AwaySince = time.Now().UnixMilli()
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	c.changed(ch)
	return c.summary(ch), nil
}

// Log returns entries newest first, before an id.
func (c *Core) Log(id, before string, limit int) ([]LogEntry, error) {
	ch, err := c.get(id)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	out := []LogEntry{}
	for i := len(ch.log) - 1; i >= 0 && len(out) < limit; i-- {
		if before != "" && ch.log[i].ID >= before {
			continue
		}
		out = append(out, ch.log[i])
	}
	return out, nil
}

// Control starts or pauses a character.
func (c *Core) Control(id string, run bool) (CharacterSummary, error) {
	ch, err := c.get(id)
	if err != nil {
		return CharacterSummary{}, err
	}
	ch.mu.Lock()
	changed := ch.rec.Run != run
	ch.rec.Run = run
	if run {
		ch.rec.NextActionAt = 0
	}
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	if changed {
		key := "paused"
		if run {
			key = "started"
		}
		c.addLog(ch, LogEntry{Kind: "system", Text: c.tr(key)})
	}
	ch.poke()
	c.changed(ch)
	return c.summary(ch), nil
}

// SetDirectives replaces a character's directives.
func (c *Core) SetDirectives(id string, d Directives) (Directives, error) {
	ch, err := c.get(id)
	if err != nil {
		return Directives{}, err
	}
	if _, ok := c.kit.Pace[d.Pace]; !ok {
		return Directives{}, errf(400, "INVALID", "pace must be relaxed, normal or active")
	}
	d.Persona = playkit.Clip(strings.TrimSpace(d.Persona), 2000)
	d.Wish = playkit.Clip(strings.TrimSpace(d.Wish), 1000)
	ch.mu.Lock()
	ch.rec.Directives = d
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	c.changed(ch)
	return d, nil
}

// Command queues a wish from the owner for the next turns and wakes the character.
func (c *Core) Command(id, text string) error {
	ch, err := c.get(id)
	if err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return errf(400, "INVALID", "text is empty")
	}
	ch.mu.Lock()
	ch.rec.Command = playkit.Clip(text, 2000)
	ch.rec.CommandTurns = c.kit.Lim("commandTurns")
	ch.rec.NextActionAt = 0
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("command", playkit.Clip(text, 200))})
	ch.poke()
	return nil
}

// Forget removes a character from this device (the agent stays in the world). Its key is deleted.
func (c *Core) Forget(id string) error {
	ch, err := c.get(id)
	if err != nil {
		return err
	}
	ch.mu.Lock()
	ch.rec.Run = false
	ch.removed = true
	if ch.cancel != nil {
		ch.cancel()
	}
	ch.mu.Unlock()
	c.mu.Lock()
	delete(c.chars, id)
	c.mu.Unlock()
	_ = c.secrets.Delete("agent:" + id)
	if err := c.store.RemoveCharacter(id); err != nil {
		return errf(500, "STORE", err.Error())
	}
	c.emit(CoreEvent{Type: "removed", ID: id})
	return nil
}

// ChatHistory returns the last messages, oldest first.
func (c *Core) ChatHistory(id string, limit int) ([]ChatMessage, error) {
	ch, err := c.get(id)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	out := ch.chat
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return append([]ChatMessage{}, out...), nil
}

// Chat answers the owner. The reply is text only: it never becomes a game action.
func (c *Core) Chat(ctx context.Context, id, text string) (ChatMessage, error) {
	ch, err := c.get(id)
	if err != nil {
		return ChatMessage{}, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return ChatMessage{}, errf(400, "INVALID", "text is empty")
	}
	text = playkit.Clip(text, c.kit.Lim("ownerText"))
	ch.mu.Lock()
	in := playkit.ChatInput{Character: ch.playkitChar(), Observation: ch.rec.Obs, Me: ch.rec.Me, Memory: ch.rec.Memory, Text: text}
	for _, m := range ch.chat {
		in.History = append(in.History, struct {
			From string `json:"from"`
			Text string `json:"text"`
		}{m.From, m.Text})
	}
	ch.mu.Unlock()
	owner := ChatMessage{ID: c.nextID(ch), TS: time.Now().UnixMilli(), From: "owner", Text: text}
	c.addChat(ch, owner)
	reply := ChatMessage{ID: c.nextID(ch), From: "character"}
	k := c.kit
	res, err := c.eng.infer(ctx, engineRequest(k.ChatTurn(in), nil, k.Sampling.ChatMaxTokens, k, func(tok string) {
		t := tok
		c.emit(CoreEvent{Type: "chat", ID: id, MessageID: reply.ID, Token: &t})
	}))
	if err != nil {
		return ChatMessage{}, errf(503, "not_available", "the AI engine is not ready: "+err.Error())
	}
	reply.TS = time.Now().UnixMilli()
	reply.Text = strings.TrimSpace(res.Text)
	empty := ""
	c.emit(CoreEvent{Type: "chat", ID: id, MessageID: reply.ID, Token: &empty, Done: true})
	c.addChat(ch, reply)
	return reply, nil
}

// EngineState, Providers, SetEngine, StartDownload, CancelDownload, TestEngine: the engine routes.
func (c *Core) EngineState() EngineState                       { return c.eng.state() }
func (c *Core) Providers(ctx context.Context) []ProviderInfo   { return c.eng.providers(ctx) }
func (c *Core) SetEngine(ch EngineChoice) (EngineState, error) { return c.eng.set(ch) }
func (c *Core) StartDownload() EngineState                     { return c.eng.download() }
func (c *Core) PauseDownload() EngineState                     { return c.eng.pauseDownload() }
func (c *Core) CancelDownload() EngineState                    { return c.eng.cancelDownload() }

// ProbeURL checks one typed address (read-only GETs, short timeout, no redirect to another host).
func (c *Core) ProbeURL(ctx context.Context, raw string) (ProviderInfo, error) {
	return c.eng.probeURL(ctx, raw)
}
func (c *Core) TestEngine(ctx context.Context) EngineTest { return c.eng.test(ctx) }

// DownloadAndWait runs the built-in download in the foreground (command line).
func (c *Core) DownloadAndWait(ctx context.Context, progress func(done, total int64)) error {
	done := make(chan error, 1)
	go func() { done <- c.eng.builtin.Download(ctx) }()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case err := <-done:
			return err
		case <-t.C:
			s := c.eng.builtin.Status()
			progress(s.BytesDone, s.BytesTotal)
		}
	}
}

// WaitEngine blocks until the engine is ready or fails.
func (c *Core) WaitEngine(ctx context.Context) error {
	_, err := c.eng.ensure(ctx)
	return err
}

func (c *Core) wakeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, ch := range c.chars {
		ch.poke()
	}
}

// charFile is where a record lives.
func (c *Core) charFile(id string) (string, error) {
	d, err := c.store.CharDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "character.json"), nil
}

func (c *Core) saveLocked(ch *character) error {
	p, err := c.charFile(ch.rec.ID)
	if err != nil || ch.removed {
		return err
	}
	return store.WriteJSON(p, ch.rec)
}

func (c *Core) loadCharacter(id string) (*character, error) {
	p, err := c.charFile(id)
	if err != nil {
		return nil, err
	}
	rec := &record{}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, rec); err != nil {
		return nil, err
	}
	if rec.ID != id {
		return nil, errors.New("id mismatch")
	}
	ch := &character{rec: rec, wake: make(chan struct{}, 1)}
	_ = c.store.ReadLines(id, "log.jsonl", maxLog, func(b []byte) error {
		var e LogEntry
		if json.Unmarshal(b, &e) == nil {
			ch.log = append(ch.log, e)
		}
		return nil
	})
	_ = c.store.ReadLines(id, "chat.jsonl", maxChat, func(b []byte) error {
		var m ChatMessage
		if json.Unmarshal(b, &m) == nil {
			ch.chat = append(ch.chat, m)
		}
		return nil
	})
	return ch, nil
}

const (
	maxLog  = 3000
	maxChat = 500
)

func (c *Core) nextID(ch *character) string {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	ch.seq++
	return fmt.Sprintf("%013d-%04d", time.Now().UnixMilli(), ch.seq%10000)
}

func (c *Core) addLog(ch *character, e LogEntry) {
	if e.ID == "" {
		e.ID = c.nextID(ch)
	}
	if e.TS == 0 {
		e.TS = time.Now().UnixMilli()
	}
	ch.mu.Lock()
	ch.log = append(ch.log, e)
	trim := len(ch.log) > maxLog+500
	if trim {
		ch.log = append([]LogEntry(nil), ch.log[len(ch.log)-maxLog:]...)
	}
	snapshot := ch.log
	ch.mu.Unlock()
	if trim {
		vals := make([]any, len(snapshot))
		for i := range snapshot {
			vals[i] = snapshot[i]
		}
		_ = c.store.RewriteLines(ch.rec.ID, "log.jsonl", vals)
	} else {
		_ = c.store.AppendLine(ch.rec.ID, "log.jsonl", e)
	}
	entry := e
	c.emit(CoreEvent{Type: "log", ID: ch.rec.ID, Entry: &entry})
}

func (c *Core) addChat(ch *character, m ChatMessage) {
	ch.mu.Lock()
	ch.chat = append(ch.chat, m)
	if len(ch.chat) > maxChat {
		ch.chat = ch.chat[len(ch.chat)-maxChat:]
	}
	ch.mu.Unlock()
	_ = c.store.AppendLine(ch.rec.ID, "chat.jsonl", m)
}

func (c *Core) changed(ch *character) {
	s := c.summary(ch)
	c.emit(CoreEvent{Type: "character", Character: &s})
}

func (c *Core) trace(ch *character, v any) {
	if c.opts.Trace {
		_ = c.store.AppendLine(ch.rec.ID, "trace.jsonl", v)
	}
}

// agentClient builds the game client for a character from its stored key.
func (c *Core) agentClient(ch *character) (*game.Client, error) {
	key, err := c.secrets.Get("agent:" + ch.rec.ID)
	if err != nil || key == "" {
		return nil, errors.New("the agent key is missing from the secret store")
	}
	gc := game.NewClient(ch.rec.ServerURL, key, c.kit.Requests.PerMinute)
	gc.MaxRetryAfter = time.Duration(c.kit.Requests.MaxRetryAfterSeconds) * time.Second
	return gc, nil
}

// jvGet is a small path reader: jvGet(v, "you", "hp").
func jvGet(v jv.Value, path ...string) jv.Value {
	for _, p := range path {
		v, _ = v.Get(p)
	}
	return v
}
