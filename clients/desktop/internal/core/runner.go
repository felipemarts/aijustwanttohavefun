package core

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/game"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// Turn limit for headless runs: after this many turns (all characters together) play stops and Done closes.
var (
	turnLimit int64
	turnCount int64
	limitDone = make(chan struct{})
	limitOnce atomic.Bool
)

var limitFor atomic.Value // character name whose turns count; "" = all

// SetTurnLimit stops play after n turns (of the character named `only`, or of all when it is ""); the returned
// channel closes then.
func (c *Core) SetTurnLimit(n int, only string) <-chan struct{} {
	atomic.StoreInt64(&turnLimit, int64(n))
	limitFor.Store(only)
	return limitDone
}

func limitReached() bool {
	l := atomic.LoadInt64(&turnLimit)
	return l > 0 && atomic.LoadInt64(&turnCount) >= l
}

func countTurn(name string) {
	if f, _ := limitFor.Load().(string); f != "" && !strings.EqualFold(f, name) {
		return
	}
	n := atomic.AddInt64(&turnCount, 1)
	if l := atomic.LoadInt64(&turnLimit); l > 0 && n >= l && limitOnce.CompareAndSwap(false, true) {
		close(limitDone)
	}
}

func (c *Core) startRunner(ch *character) {
	ctx, cancel := context.WithCancel(c.ctx)
	ch.mu.Lock()
	ch.cancel = cancel
	ch.mu.Unlock()
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.runLoop(ctx, ch)
	}()
}

// wait sleeps for d or until poked; true when poked.
func (c *Core) wait(ctx context.Context, ch *character, d time.Duration) bool {
	if d <= 0 {
		d = time.Hour
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-ch.wake:
		return true
	case <-t.C:
		return false
	}
}

func (c *Core) setLive(ch *character, status, problem string) {
	ch.mu.Lock()
	changed := ch.status != status || ch.problem != problem
	ch.status, ch.problem = status, problem
	ch.mu.Unlock()
	if changed {
		c.changed(ch)
	}
}

func (c *Core) pace(ch *character) (turns int, gap, poll time.Duration) {
	ch.mu.Lock()
	p := ch.rec.Directives.Pace
	ch.mu.Unlock()
	cfg, ok := c.kit.Pace[p]
	if !ok {
		cfg = c.kit.Pace["normal"]
	}
	return cfg.SessionTurns, time.Duration(cfg.GapSeconds) * time.Second, time.Duration(cfg.PollSeconds) * time.Second
}

func (c *Core) runLoop(ctx context.Context, ch *character) {
	for ctx.Err() == nil {
		ch.mu.Lock()
		run, next := ch.rec.Run, ch.rec.NextActionAt
		ch.mu.Unlock()
		if !run || limitReached() {
			c.setLive(ch, "", "")
			c.wait(ctx, ch, 0)
			continue
		}
		if _, err := c.eng.ensure(ctx); err != nil {
			msg := c.eng.state().Message
			if msg == "" {
				msg = c.tr("eng_not_installed")
			}
			c.setLive(ch, "", msg)
			c.wait(ctx, ch, 15*time.Second)
			continue
		}
		gc, err := c.agentClient(ch)
		if err != nil {
			c.setLive(ch, "", c.tr("no_key"))
			c.wait(ctx, ch, time.Minute)
			continue
		}
		now := time.Now().UnixMilli()
		if next > now {
			// A problem stays shown while waiting to retry; a session that starts clears it.
			ch.mu.Lock()
			problem := ch.problem
			ch.mu.Unlock()
			c.setLive(ch, "resting", problem)
			_, _, poll := c.pace(ch)
			d := time.Duration(next-now) * time.Millisecond
			if d > poll {
				d = poll
			}
			if !c.wait(ctx, ch, d) && time.Now().UnixMilli() < next {
				c.pollEvents(ctx, ch, gc)
			}
			continue
		}
		c.session(ctx, ch, gc)
	}
}

// pollEvents reads GET /events since the cursor between sessions; a directed event wakes the character.
func (c *Core) pollEvents(ctx context.Context, ch *character, gc *game.Client) {
	ch.mu.Lock()
	cursor := ch.rec.Cursor
	ch.mu.Unlock()
	woke := ""
	for page := 0; page < 5; page++ {
		body, err := gc.Events(ctx, cursor)
		if err != nil {
			return
		}
		for _, e := range jvGet(body, "events").A {
			c.logMessage(ch, e)
			if woke == "" && c.kit.Wakes(e, ch.rec.Name) {
				woke = jvGet(e, "kind").Text()
			}
		}
		if cur := jvGet(body, "cursor").Text(); cur != "" {
			cursor = cur
		}
		if m := jvGet(body, "more"); !(m.Kind == jv.Bool && m.B) {
			break
		}
	}
	ch.mu.Lock()
	ch.rec.Cursor = cursor
	ch.skipLookLog = true
	if woke != "" {
		ch.rec.NextActionAt = 0
	}
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	if woke != "" {
		c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("woke", strings.ReplaceAll(woke, "_", " "))})
	}
}

var bigKinds = map[string]bool{"level_up": true, "achievement": true, "rare_drop": true, "fountain_jackpot": true, "title": true, "fallen": true, "quest_done": true, "pvp_kill": true, "betrayal": true}

// logMessage turns one game message into a log entry: agent-written text becomes a quote, never plain text.
func (c *Core) logMessage(ch *character, m jv.Value) {
	kind := jvGet(m, "kind").Text()
	e := LogEntry{Kind: "event", Big: bigKinds[kind]}
	if u, ok := m.Get("untrusted_text"); ok {
		from := jvGet(m, "from").Text()
		e.Quote = &Quote{From: from, Text: u.Text()}
		e.Text = from + " (" + strings.ReplaceAll(kind, "_", " ") + ")"
	} else {
		e.Text = jvGet(m, "text").Text()
		if e.Text == "" {
			return
		}
	}
	if e.Big && e.Quote == nil {
		ch.mu.Lock()
		ch.addHighlight(e.Text)
		ch.mu.Unlock()
	}
	c.addLog(ch, e)
}

func (ch *character) addHighlight(s string) {
	h := append([]string{playkit.Clip(s, 160)}, ch.rec.Away.Highlights...)
	if len(h) > 5 {
		h = h[:5]
	}
	ch.rec.Away.Highlights = h
}

// mergeObs applies a response to the stored observation: parts present replace, parts absent are kept.
func mergeObs(prev, body jv.Value, full bool) jv.Value {
	out := jv.Obj()
	if !full && prev.Kind == jv.Object {
		out = prev.Clone()
	}
	for _, k := range []string{"you", "room", "actions", "time", "quest", "pending", "boss"} {
		if v, ok := body.Get(k); ok {
			out.Set(k, v)
		}
	}
	return out
}

func xpGain(prev, cur jv.Value) int {
	l0, l1 := jvGet(prev, "lvl").N, jvGet(cur, "lvl").N
	x0, n0 := gaugeOf(jvGet(prev, "xp")), gaugeOf(jvGet(cur, "xp"))
	_ = n0
	if l1 == l0 {
		return int(gaugeOf(jvGet(cur, "xp"))[0] - x0[0])
	}
	if l1 > l0 {
		return int((x0[1] - x0[0]) + gaugeOf(jvGet(cur, "xp"))[0])
	}
	return 0
}

func engineRequest(msgs []playkit.Message, schema *jv.Value, maxTokens int, k *playkit.Kit, onToken func(string)) engine.Request {
	return engine.Request{Messages: msgs, Schema: schema, MaxTokens: maxTokens, Temperature: k.Sampling.Temperature, TopK: k.Sampling.TopK, RepeatPenalty: k.Sampling.RepeatPenalty, OnToken: onToken}
}

type turnTrace struct {
	TS       int64             `json:"ts"`
	Turn     int               `json:"turn"`
	Messages []playkit.Message `json:"messages"`
	Menu     []string          `json:"menu"`
	Answer   string            `json:"answer"`
	Retry    string            `json:"retry,omitempty"`
	Source   string            `json:"source"`
	Problem  string            `json:"problem,omitempty"`
	Action   string            `json:"action,omitempty"`
	Params   jv.Value          `json:"params"`
	Result   jv.Value          `json:"result"`
	InferMs  int64             `json:"inferMs"`
	TurnMs   int64             `json:"turnMs"`
	Tokens   int               `json:"tokens"`
	Prompt   int               `json:"promptTokens"`
	TPS      float64           `json:"tps"`
	Mode     string            `json:"mode"`
}

// session plays one session: look, then turns until the pace's turn count, AP, or nothing left to do.
func (c *Core) session(ctx context.Context, ch *character, gc *game.Client) {
	k := c.kit
	block := func(msg string, retry time.Duration) {
		ch.mu.Lock()
		ch.rec.NextActionAt = time.Now().Add(retry).UnixMilli()
		ch.mu.Unlock()
		c.setLive(ch, "", msg)
	}
	doc, err := c.schemaFor(ctx, ch.rec.ServerURL)
	if err != nil {
		block(c.tr("no_server"), 30*time.Second)
		return
	}
	look, err := gc.Look(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		if game.IsUnauthorized(err) {
			block(c.tr("bad_key"), 10*time.Minute)
		} else {
			block(c.tr("no_server"), 30*time.Second)
		}
		return
	}
	c.setLive(ch, "playing", "")
	me, meErr := gc.Me(ctx)
	ch.mu.Lock()
	ch.rec.Obs = mergeObs(ch.rec.Obs, look, true)
	k.Observe(&ch.rec.Memory.World, ch.rec.Obs)
	if cur := jvGet(look, "cursor").Text(); cur != "" {
		ch.rec.Cursor = cur
	}
	newlyClaimed := false
	if meErr == nil {
		ch.rec.Me = me
		claimed := jvGet(me, "agent", "claimed").B
		newlyClaimed = claimed && !ch.rec.Claimed
		ch.rec.Claimed = claimed
		if claimed {
			ch.rec.ClaimURL = ""
		}
	}
	skip := ch.skipLookLog
	ch.skipLookLog = false
	ch.rec.Stats.Sessions++
	ap := int(gaugeOf(jvGet(ch.rec.Obs, "you", "ap"))[0])
	ch.mu.Unlock()
	if newlyClaimed {
		c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("claimed")})
	}
	c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("session", ap)})
	wmap := c.worldMap(ctx, ch.rec.ServerURL)
	c.probe(ctx, ch)
	chat, events := playkit.Heard(jvGet(look, "messages"))
	if !skip {
		for _, m := range jvGet(look, "messages").A {
			c.logMessage(ch, m)
		}
	}
	ch.mu.Lock()
	k.Remember(&ch.rec.Memory, nil, "", chat)
	k.Track(&ch.rec.Memory, playkit.Update{Before: ch.rec.Obs, After: ch.rec.Obs, Action: "look", Params: jv.Obj(), Chat: chat, Self: ch.rec.Name})
	ch.mu.Unlock()
	last := &playkit.Last{Action: "look", Params: jv.Obj(), OK: true, Narration: jvGet(look, "narration").Text()}

	sessionTurns, gap, _ := c.pace(ch)
	why := "why_turns"
	var recoverWait time.Duration
	for t := 0; t < sessionTurns; t++ {
		ch.mu.Lock()
		run := ch.rec.Run
		ch.mu.Unlock()
		if ctx.Err() != nil || !run || limitReached() {
			why = ""
			break
		}
		turnStart := time.Now()
		ch.mu.Lock()
		apNow := int(gaugeOf(jvGet(ch.rec.Obs, "you", "ap"))[0])
		in := playkit.TurnInput{Character: ch.playkitChar(), Observation: ch.rec.Obs, Me: ch.rec.Me, Last: last, Events: events, Memory: ch.rec.Memory, Map: wmap}
		if ch.rec.CommandTurns > 0 {
			in.Command = ch.rec.Command
		}
		ch.mu.Unlock()
		if apNow < k.AP.StopBelow {
			why = "why_ap"
			break
		}
		turn := k.BuildTurn(doc, in)
		if turn.End == "recover" {
			why = "why_recover"
			recoverWait = time.Duration(k.Planner.RecoverWaitSeconds) * time.Second
			break
		}
		if turn.End != "" || len(turn.Menu.Actions) == 0 {
			why = "why_none"
			break
		}
		c.setLive(ch, "thinking", "")
		schema := turn.Menu.Schema
		res1, err := c.eng.infer(ctx, engineRequest(turn.Messages, &schema, k.Sampling.MaxTokens, k, nil))
		if err != nil && ctx.Err() == nil && !errors.Is(err, engine.ErrUnreachable) && !errors.Is(err, ErrTimeout) {
			// The engine refused the request itself (an unsupported schema feature, say): ask once without the
			// constraint. The answer is validated against the same menu all the same.
			c.logf("engine refused the constrained request (%v); asking without the schema", err)
			res1, err = c.eng.infer(ctx, engineRequest(turn.Messages, nil, k.Sampling.MaxTokens, k, nil))
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			// A short localised reason for the owner; the detail (truncated, no secrets) in the log; back off.
			reason := c.tr("eng_failed")
			switch {
			case errors.Is(err, ErrTimeout):
				reason = c.tr("eng_timeout")
			case errors.Is(err, engine.ErrUnreachable):
				reason = c.tr("eng_unreachable")
			}
			c.addLog(ch, LogEntry{Kind: "system", Text: reason + " " + playkit.Clip(playkit.OneLine(err.Error()), 200)})
			block(reason, time.Duration(k.Engine.BackoffSeconds)*time.Second)
			return
		}
		inferMs := res1.Elapsed.Milliseconds()
		tokens, promptTokens, tps, mode := res1.CompletionTokens, res1.PromptTokens, res1.TokensPerSecond, res1.Mode
		retryText := ""
		res := k.Resolve(turn.Menu, res1.Text, func(problem string) (string, error) {
			r2, err := c.eng.infer(ctx, engineRequest(k.RetryMessages(turn.Messages, res1.Text, problem), &schema, k.Sampling.MaxTokens, k, nil))
			if err != nil {
				return "", err
			}
			inferMs += r2.Elapsed.Milliseconds()
			tokens += r2.CompletionTokens
			retryText = r2.Text
			return r2.Text, nil
		})
		c.setLive(ch, "playing", "")
		if res.Source == "none" {
			why = "why_none"
			break
		}
		if res.Source == "fallback" {
			c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("fallback")})
		}
		d := res.Decision
		body, err := gc.Act(ctx, d.Action, d.Params)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if game.IsUnauthorized(err) {
				block(c.tr("bad_key"), 10*time.Minute)
			} else {
				block(c.tr("no_server"), 30*time.Second)
			}
			return
		}
		okv := jvGet(body, "ok")
		ok := okv.Kind == jv.Bool && okv.B
		var gerr *playkit.GameErr
		ch.mu.Lock()
		prevObs := ch.rec.Obs.Clone()
		prevYou := jvGet(ch.rec.Obs, "you")
		st := &ch.rec.Stats
		st.Turns++
		st.InferMs += inferMs
		st.Tokens += tokens
		if tps > 0 {
			st.LastTPS = tps
		}
		switch res.Source {
		case "first":
			st.FirstValid++
		case "retry":
			st.Retried++
		case "fallback":
			st.Fallbacks++
		}
		var entry LogEntry
		if ok {
			st.Accepted++
			if d.Action == "say" || d.Action == "whisper" || d.Action == "party_say" || d.Action == "guild_say" {
				st.SaidThings++
			}
			ch.rec.Obs = mergeObs(ch.rec.Obs, body, false)
			if body.Has("room") {
				k.Observe(&ch.rec.Memory.World, ch.rec.Obs)
			}
			cur := jvGet(ch.rec.Obs, "you")
			narr := jvGet(body, "narration").Text()
			delta := &LogDelta{}
			if g := xpGain(prevYou, cur); g != 0 {
				delta.XP = &g
				ch.rec.Away.XP += g
				if (d.Action == "attack" || d.Action == "cast") && g > 0 {
					ch.rec.Away.Kills++
				}
			}
			if g := int(jvGet(cur, "gold").N - jvGet(prevYou, "gold").N); g != 0 {
				delta.Gold = &g
				ch.rec.Away.Gold += g
			}
			if h := int(gaugeOf(jvGet(cur, "hp"))[0] - gaugeOf(jvGet(prevYou, "hp"))[0]); h != 0 {
				delta.HP = &h
			}
			big := false
			if l := int(jvGet(cur, "lvl").N - jvGet(prevYou, "lvl").N); l > 0 {
				lv := int(jvGet(cur, "lvl").N)
				delta.Level = &lv
				ch.rec.Away.Levels += l
				ch.addHighlight(c.tr("hl_level", lv))
				big = true
			}
			if cur.Has("fallen") && !prevYou.Has("fallen") {
				ch.rec.Away.Deaths++
				big = true
			}
			if delta.XP == nil && delta.Gold == nil && delta.HP == nil && delta.Level == nil {
				delta = nil
			}
			ch.rec.Away.Actions++
			entry = LogEntry{Kind: "action", Text: narr, Action: d.Action, Thought: c.showThought(ch, d.Thought), Delta: delta, Big: big}
			var data *jv.Value
			if dv, has := body.Get("data"); has && dv.Kind != jv.Null {
				data = &dv
			}
			last = &playkit.Last{Action: d.Action, Params: d.Params, OK: true, Narration: narr, Data: data}
		} else {
			st.Refused++
			e := jvGet(body, "error")
			gerr = &playkit.GameErr{Code: jvGet(e, "code").Text(), Message: jvGet(e, "message").Text(), Hint: jvGet(e, "hint").Text()}
			text := gerr.Message
			if gerr.Hint != "" {
				text += " " + gerr.Hint
			}
			entry = LogEntry{Kind: "refused", Text: text, Action: d.Action, Thought: c.showThought(ch, d.Thought)}
			last = &playkit.Last{Action: d.Action, Params: d.Params, OK: false, Error: gerr}
		}
		if cur := jvGet(body, "cursor").Text(); cur != "" {
			ch.rec.Cursor = cur
		}
		ch.mu.Unlock()
		c.addLog(ch, entry)
		var heardChat []playkit.ChatLine
		heardChat, events = playkit.Heard(jvGet(body, "messages"))
		for _, m := range jvGet(body, "messages").A {
			c.logMessage(ch, m)
		}
		narration := ""
		if ok {
			narration = last.Narration
		}
		ch.mu.Lock()
		k.Track(&ch.rec.Memory, playkit.Update{Before: prevObs, After: ch.rec.Obs, Action: d.Action, Params: d.Params, OK: ok, Chat: heardChat, Self: ch.rec.Name, Lost: turn.Lost})
		if reason := k.StuckReason(ch.rec.Memory); reason != ch.rec.Stuck.Reason {
			ch.rec.Stuck = stuckState{Reason: reason}
			if reason != "" {
				ch.rec.Stuck.Since = time.Now().UnixMilli()
			}
		}
		moved := jvGet(prevObs, "room", "id").Text() != jvGet(ch.rec.Obs, "room", "id").Text()
		needCompact := k.Remember(&ch.rec.Memory, ptr(playkit.RecentOf(d.Action, d.Params, ok, narration, gerr)), d.Note, heardChat)
		if ch.rec.CommandTurns > 0 {
			ch.rec.CommandTurns--
			if ch.rec.CommandTurns == 0 {
				ch.rec.Command = ""
			}
		}
		notes := append([]string{}, ch.rec.Memory.Notes...)
		ch.mu.Unlock()
		if needCompact {
			msgs, cschema := k.CompactionTurn(ch.rec.Name, notes)
			if r, err := c.eng.infer(ctx, engineRequest(msgs, &cschema, 400, k, nil)); err == nil {
				ch.mu.Lock()
				ch.rec.Memory.Notes = k.ApplyCompaction(r.Text, ch.rec.Memory.Notes)
				ch.rec.Stats.Compactions++
				ch.mu.Unlock()
				c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("memory")})
			} else {
				ch.mu.Lock()
				ch.rec.Memory.Notes = k.ApplyCompaction("", ch.rec.Memory.Notes)
				ch.mu.Unlock()
			}
		}
		if moved {
			c.probe(ctx, ch)
		}
		gained := ok && xpGain(jvGet(prevObs, "you"), jvGet(ch.rec.Obs, "you")) > 0
		if ok && (k.RefreshesMe(d.Action) || gained) {
			if me, err := gc.Me(ctx); err == nil {
				ch.mu.Lock()
				ch.rec.Me = me
				ch.mu.Unlock()
			}
		}
		turnMs := time.Since(turnStart).Milliseconds()
		ch.mu.Lock()
		ch.rec.Stats.TurnMs += turnMs
		_ = c.saveLocked(ch)
		ch.mu.Unlock()
		c.trace(ch, turnTrace{TS: time.Now().UnixMilli(), Turn: ch.rec.Stats.Turns, Messages: turn.Messages, Menu: turn.Menu.Names(), Answer: res1.Text, Retry: retryText,
			Source: res.Source, Problem: res.FirstProblem, Action: d.Action, Params: d.Params, Result: body, InferMs: inferMs, TurnMs: turnMs, Tokens: tokens, Prompt: promptTokens, TPS: tps, Mode: mode})
		c.changed(ch)
		countTurn(ch.rec.Name)
		if !ok && gerr != nil && gerr.Code == "COOLDOWN" {
			time.Sleep(time.Duration(k.Requests.CooldownWaitSeconds) * time.Second)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(k.Requests.TurnGapMs) * time.Millisecond):
		}
	}
	// Rest until the next session: the pace's gap, and long enough for AP to come back.
	ch.mu.Lock()
	apEnd := int(gaugeOf(jvGet(ch.rec.Obs, "you", "ap"))[0])
	if recoverWait > gap {
		gap = recoverWait
	}
	next := time.Now().Add(gap)
	if need := k.AP.ResumeAt - apEnd; need > 0 {
		if t := time.Now().Add(time.Duration(need*k.AP.RegenSeconds) * time.Second); t.After(next) {
			next = t
		}
	}
	ch.rec.NextActionAt = next.UnixMilli()
	_ = c.saveLocked(ch)
	ch.mu.Unlock()
	if why != "" {
		c.addLog(ch, LogEntry{Kind: "system", Text: c.tr("session_end", c.tr(why))})
	}
	c.setLive(ch, "resting", "")
}

func ptr[T any](v T) *T { return &v }

// showThought is the thought as the owner reads it: without a leading own name (small models write it whatever the
// prompt says), with the current room's id replaced by its name.
func (c *Core) showThought(ch *character, t string) string {
	ch.mu.Lock()
	name := ch.rec.Name
	room := jvGet(ch.rec.Obs, "room")
	ch.mu.Unlock()
	t = playkit.StripName(t, name)
	if id, rn := jvGet(room, "id").Text(), jvGet(room, "name").Text(); id != "" && rn != "" {
		t = strings.ReplaceAll(t, id, rn)
	}
	return t
}

// probe reads GET /api/public/rooms/<id> for the rooms behind the current exits whose danger is unknown (v2), so
// routes never lead into a room far above the character's level.
func (c *Core) probe(ctx context.Context, ch *character) {
	ch.mu.Lock()
	ids := playkit.ToProbe(ch.rec.Memory.World, ch.rec.Obs)
	base := ch.rec.ServerURL
	ch.mu.Unlock()
	for _, id := range ids {
		pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		v, err := game.PublicRoom(pctx, base, id)
		cancel()
		if err != nil {
			continue
		}
		ch.mu.Lock()
		c.kit.ObserveProbe(&ch.rec.Memory.World, id, v)
		ch.mu.Unlock()
	}
}
