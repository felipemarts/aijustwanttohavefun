package core

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// record is what is saved in characters/<id>/character.json. The API key is not here (secret store).
type record struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Class      string         `json:"class"`
	Language   string         `json:"language"`
	ServerURL  string         `json:"serverUrl"`
	ClaimURL   string         `json:"claimUrl,omitempty"`
	Bio        string         `json:"bio,omitempty"`
	Claimed    bool           `json:"claimed"`
	Sprite     string         `json:"sprite,omitempty"`
	CreatedAt  int64          `json:"createdAt"`
	Run        bool           `json:"run"`
	Directives Directives     `json:"directives"`
	Memory     playkit.Memory `json:"memory"`
	Cursor     string         `json:"cursor"`
	// Obs is the merged last observation; Me the last GET /me.
	Obs          jv.Value     `json:"obs"`
	Me           jv.Value     `json:"me"`
	Command      string       `json:"command,omitempty"`
	CommandTurns int          `json:"commandTurns,omitempty"`
	NextActionAt int64        `json:"nextActionAt,omitempty"`
	AwaySince    int64        `json:"awaySince"`
	Away         awayCounters `json:"away"`
	Stats        playStats    `json:"stats"`
	Stuck        stuckState   `json:"stuck,omitempty"`
}

// stuckState is CharacterSummary.stuck: why and since when (ms) the character makes no progress.
type stuckState struct {
	Reason string `json:"reason,omitempty"`
	Since  int64  `json:"since,omitempty"`
}

type awayCounters struct {
	Actions    int      `json:"actions"`
	Levels     int      `json:"levels"`
	XP         int      `json:"xp"`
	Gold       int      `json:"gold"`
	Kills      int      `json:"kills"`
	Deaths     int      `json:"deaths"`
	Highlights []string `json:"highlights,omitempty"`
}

// playStats are lifetime counters, for the owner and for measuring an engine.
type playStats struct {
	Turns       int     `json:"turns"`
	FirstValid  int     `json:"firstValid"`
	Retried     int     `json:"retried"`
	Fallbacks   int     `json:"fallbacks"`
	Accepted    int     `json:"accepted"`
	Refused     int     `json:"refused"`
	InferMs     int64   `json:"inferMs"`
	TurnMs      int64   `json:"turnMs"`
	Tokens      int     `json:"tokens"`
	LastTPS     float64 `json:"lastTps"`
	Sessions    int     `json:"sessions"`
	SaidThings  int     `json:"saidThings"`
	Compactions int     `json:"compactions"`
}

type character struct {
	mu      sync.Mutex
	rec     *record
	log     []LogEntry
	chat    []ChatMessage
	seq     int
	wake    chan struct{}
	cancel  context.CancelFunc
	removed bool

	// live, not saved
	skipLookLog bool   // the next /look's messages were already logged from /events
	status      string // playing, thinking, resting, paused, fallen, blocked
	problem     string
	activity    string
}

func (ch *character) poke() {
	select {
	case ch.wake <- struct{}{}:
	default:
	}
}

func (ch *character) playkitChar() playkit.Character {
	d := ch.rec.Directives
	return playkit.Character{Name: ch.rec.Name, Class: ch.rec.Class, Language: ch.rec.Language, Persona: d.Persona, Wish: d.Wish, AllowPvp: d.AllowPvp}
}

func gaugeOf(v jv.Value) Gauge {
	if v.Kind == jv.Array && len(v.A) == 2 {
		return Gauge{v.A[0].N, v.A[1].N}
	}
	return Gauge{0, 0}
}

func (c *Core) summary(ch *character) CharacterSummary {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	r := ch.rec
	you := jvGet(r.Obs, "you")
	room := jvGet(r.Obs, "room")
	s := CharacterSummary{
		ID: r.ID, Name: r.Name, Class: r.Class,
		Level: int(jvGet(you, "lvl").N),
		XP:    gaugeOf(jvGet(you, "xp")), HP: gaugeOf(jvGet(you, "hp")), MP: gaugeOf(jvGet(you, "mp")), AP: gaugeOf(jvGet(you, "ap")),
		Gold:     int(jvGet(you, "gold").N),
		Room:     RoomRef{ID: jvGet(room, "id").Text(), Name: jvGet(room, "name").Text()},
		Claimed:  r.Claimed,
		WatchURL: r.ServerURL + "/a/" + url.PathEscape(r.Name),
	}
	if s.Level == 0 {
		s.Level = 1
	}
	if r.Sprite != "" {
		sp := r.Sprite
		s.Sprite = &sp
	}
	if t := jvGet(you, "title").Text(); t != "" {
		s.Title = &t
	}
	s.ClaimPending = !r.Claimed && r.ClaimURL != ""
	if r.Stuck.Reason != "" {
		s.Stuck = &Stuck{Since: r.Stuck.Since, Reason: r.Stuck.Reason}
	}
	s.Status, s.Problem = c.statusOf(ch)
	s.Activity = c.activityOf(ch, s.Status)
	if s.Status == "resting" && r.NextActionAt > 0 {
		s.NextActionAt = r.NextActionAt
	}
	a := r.Away
	if a.Actions > 0 || a.Levels > 0 || len(a.Highlights) > 0 {
		hl := append([]string{}, a.Highlights...)
		s.Away = &AwaySummary{Since: r.AwaySince, Actions: a.Actions, Levels: a.Levels, XP: a.XP, Gold: a.Gold, Kills: a.Kills, Deaths: a.Deaths, Highlights: hl}
	}
	return s
}

// statusOf derives the status (caller holds ch.mu).
func (c *Core) statusOf(ch *character) (string, string) {
	if ch.problem != "" {
		return "blocked", ch.problem
	}
	if !ch.rec.Run {
		return "paused", ""
	}
	if jvGet(ch.rec.Obs, "you").Has("fallen") && ch.status != "thinking" {
		return "fallen", ""
	}
	if ch.status == "" {
		return "resting", ""
	}
	return ch.status, ""
}

func (c *Core) activityOf(ch *character, status string) string {
	switch status {
	case "paused":
		return c.tr("act_paused")
	case "blocked":
		return c.tr("act_blocked")
	case "thinking":
		return c.tr("act_thinking")
	case "fallen":
		return c.tr("act_fallen")
	case "resting":
		if ch.rec.NextActionAt > 0 {
			return c.tr("act_resting_until", time.UnixMilli(ch.rec.NextActionAt).Format("15:04"))
		}
		return c.tr("act_resting")
	}
	if ch.activity != "" {
		return ch.activity
	}
	if ic := jvGet(ch.rec.Obs, "you", "in_combat").Text(); ic != "" {
		return c.tr("act_fighting", humanize(ic))
	}
	return c.tr("act_in", jvGet(ch.rec.Obs, "room", "name").Text())
}

// humanize turns an id into a display name: "minor_potion" -> "Minor potion". The compact API gives ids only.
func humanize(id string) string {
	s := strings.ReplaceAll(id, "_", " ")
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func (c *Core) detail(ch *character) CharacterDetail {
	d := CharacterDetail{CharacterSummary: c.summary(ch)}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	r := ch.rec
	d.Directives = r.Directives
	d.Memory = append([]string{}, r.Memory.Notes...)
	d.Stats = []StatEntry{}
	for _, m := range jvGet(r.Me, "stats").O {
		d.Stats = append(d.Stats, StatEntry{ID: m.Key, Name: c.label("stat", m.Key), Value: m.Val.N})
	}
	d.Bio = r.Bio
	if b := jvGet(r.Me, "agent", "bio", "untrusted_text").Text(); b != "" {
		d.Bio = b
	}
	d.Inventory = []ItemStack{}
	for _, m := range jvGet(r.Me, "inventory").O {
		if m.Val.N > 0 {
			d.Inventory = append(d.Inventory, ItemStack{ID: m.Key, Name: m.Key, Qty: int(m.Val.N)})
		}
	}
	for _, m := range jvGet(r.Me, "equipment").O {
		d.Inventory = append(d.Inventory, ItemStack{ID: m.Val.Text(), Name: m.Val.Text(), Qty: 1, Slot: &NamedRef{ID: m.Key, Name: c.label("slot", m.Key)}})
	}
	d.Quests = []QuestProgress{}
	for _, q := range jvGet(r.Me, "quests").A {
		qp := QuestProgress{ID: jvGet(q, "id").Text(), Name: jvGet(q, "id").Text(), Ready: jvGet(q, "ready").B, Steps: []QuestStep{}}
		for _, s := range jvGet(q, "steps").A {
			qp.Steps = append(qp.Steps, QuestStep{Text: strings.TrimSpace(jvGet(s, "do").Text() + " " + jvGet(s, "target").Text()), Have: int(jvGet(s, "have").N), Need: int(jvGet(s, "need").N)})
		}
		d.Quests = append(d.Quests, qp)
	}
	type ach struct {
		id string
		at float64
	}
	var achs []ach
	for _, m := range jvGet(r.Me, "achievements").O {
		achs = append(achs, ach{m.Key, m.Val.N})
	}
	sort.SliceStable(achs, func(i, j int) bool { return achs[i].at > achs[j].at })
	d.Achievements = []string{}
	for _, a := range achs {
		d.Achievements = append(d.Achievements, humanize(a.id))
	}
	if p := jvGet(r.Obs, "you", "party"); p.Kind == jv.Object {
		pi := &PartyInfo{Members: []string{}}
		for _, m := range jvGet(p, "members").A {
			pi.Members = append(pi.Members, m.Text())
		}
		d.Party = pi
	}
	if g := jvGet(r.Obs, "you", "guild").Text(); g != "" {
		d.Guild = &g
	}
	return d
}

// labels: names of stats and equipment slots in the interface language (the only names the core localizes; rooms,
// items and quests are shown as the game returns them).
var labels = map[string]map[string]string{
	"en": {
		"stat.str": "Strength", "stat.int": "Intellect", "stat.agi": "Agility", "stat.vit": "Vitality",
		"stat.atk": "Attack", "stat.def": "Defence", "stat.crit": "Critical chance",
		"slot.weapon": "Weapon", "slot.body": "Body", "slot.head": "Head", "slot.offhand": "Off hand",
		"slot.hands": "Hands", "slot.feet": "Feet", "slot.legs": "Legs", "slot.accessory": "Accessory", "slot.ring": "Ring", "slot.neck": "Neck",
	},
	"pt-BR": {
		"stat.str": "Força", "stat.int": "Intelecto", "stat.agi": "Agilidade", "stat.vit": "Vitalidade",
		"stat.atk": "Ataque", "stat.def": "Defesa", "stat.crit": "Chance de crítico",
		"slot.weapon": "Arma", "slot.body": "Corpo", "slot.head": "Cabeça", "slot.offhand": "Mão secundária",
		"slot.hands": "Mãos", "slot.feet": "Pés", "slot.legs": "Pernas", "slot.accessory": "Acessório", "slot.ring": "Anel", "slot.neck": "Pescoço",
	},
}

func (c *Core) label(kind, id string) string {
	lang, _ := c.lang.Load().(string)
	for _, l := range []string{lang, "en"} {
		if n, ok := labels[l][kind+"."+id]; ok {
			return n
		}
	}
	return humanize(id)
}

// ── interface-language strings ───────────────────────────────────────────────────────────────────────────────────

var strs = map[string]map[string]string{
	"en": {
		"created":             "%s was created. Open the claim link so it can speak.",
		"started":             "Started playing.",
		"paused":              "Paused by the owner.",
		"command":             "Owner asked: %s",
		"act_paused":          "Paused",
		"act_blocked":         "Cannot play",
		"act_thinking":        "Thinking…",
		"act_fallen":          "Fallen, waiting",
		"act_resting":         "Resting",
		"act_resting_until":   "Resting until %s",
		"act_fighting":        "Fighting: %s",
		"act_in":              "In %s",
		"session":             "Session started (AP %d).",
		"session_end":         "Session over: %s.",
		"why_turns":           "enough for now",
		"why_ap":              "out of AP",
		"why_none":            "nothing to do",
		"why_recover":         "resting to recover HP",
		"no_engine":           "The AI engine is not ready: %s",
		"no_server":           "The game server does not answer.",
		"bad_key":             "The game server refused this agent's key.",
		"no_key":              "The agent key is missing on this device.",
		"fallback":            "The model gave no valid answer; played a safe action.",
		"woke":                "Woke up early: %s.",
		"claimed":             "Claimed by its owner: it can speak now.",
		"memory":              "Tidied its notes.",
		"hl_level":            "Reached level %d",
		"eng_paused":          "Download paused.",
		"eng_cancelled":       "Download cancelled.",
		"eng_checking":        "Checking the model file…",
		"eng_loading":         "Loading the model…",
		"eng_hash_mismatch":   "The model file was damaged and was deleted. Download it again.",
		"eng_start_failed":    "The AI engine could not start.",
		"eng_not_ready":       "The AI engine did not start in time.",
		"eng_download_failed": "The download failed. Try again.",
		"eng_stopped":         "The AI engine stopped unexpectedly.",
		"eng_unsupported":     "No built-in engine for this computer. Use Ollama, LM Studio or another server.",
		"eng_timeout":         "The AI engine took too long to answer.",
		"eng_unreachable":     "The AI engine does not answer.",
		"eng_failed":          "The AI engine failed (details in the log).",
		"eng_not_installed":   "The AI model is not downloaded yet.",
		"stuck_note":          "Seems stuck: %s",
	},
	"pt-BR": {
		"created":             "%s foi criado. Abra o link de reivindicação para que possa falar.",
		"started":             "Começou a jogar.",
		"paused":              "Pausado pelo dono.",
		"command":             "O dono pediu: %s",
		"act_paused":          "Pausado",
		"act_blocked":         "Não pode jogar",
		"act_thinking":        "Pensando…",
		"act_fallen":          "Caído, esperando",
		"act_resting":         "Descansando",
		"act_resting_until":   "Descansando até %s",
		"act_fighting":        "Lutando: %s",
		"act_in":              "Em %s",
		"session":             "Sessão iniciada (PA %d).",
		"session_end":         "Sessão encerrada: %s.",
		"why_turns":           "chega por agora",
		"why_ap":              "sem PA",
		"why_none":            "nada a fazer",
		"why_recover":         "descansando para recuperar PV",
		"no_engine":           "O motor de IA não está pronto: %s",
		"no_server":           "O servidor do jogo não responde.",
		"bad_key":             "O servidor recusou a chave deste agente.",
		"no_key":              "A chave do agente não está neste dispositivo.",
		"fallback":            "O modelo não deu resposta válida; fez uma ação segura.",
		"woke":                "Acordou mais cedo: %s.",
		"claimed":             "Reivindicado pelo dono: agora pode falar.",
		"memory":              "Organizou suas anotações.",
		"hl_level":            "Chegou ao nível %d",
		"eng_paused":          "Download pausado.",
		"eng_cancelled":       "Download cancelado.",
		"eng_checking":        "Verificando o arquivo do modelo…",
		"eng_loading":         "Carregando o modelo…",
		"eng_hash_mismatch":   "O arquivo do modelo estava danificado e foi apagado. Baixe de novo.",
		"eng_start_failed":    "O motor de IA não conseguiu iniciar.",
		"eng_not_ready":       "O motor de IA não iniciou a tempo.",
		"eng_download_failed": "O download falhou. Tente de novo.",
		"eng_stopped":         "O motor de IA parou inesperadamente.",
		"eng_unsupported":     "Não há motor embutido para este computador. Use Ollama, LM Studio ou outro servidor.",
		"eng_timeout":         "O motor de IA demorou demais para responder.",
		"eng_unreachable":     "O motor de IA não responde.",
		"eng_failed":          "O motor de IA falhou (detalhes no registro).",
		"eng_not_installed":   "O modelo de IA ainda não foi baixado.",
		"stuck_note":          "Parece travado: %s",
	},
}

// tr formats an interface string in the settings language (English when missing). It takes no lock, so it may be
// called while a character is locked.
func (c *Core) tr(key string, a ...any) string {
	lang, _ := c.lang.Load().(string)
	t, ok := strs[lang][key]
	if !ok {
		primary, _, _ := strings.Cut(lang, "-")
		for l, m := range strs {
			if strings.HasPrefix(l, primary) {
				if t2, ok := m[key]; ok {
					t, ok = t2, true
					break
				}
			}
		}
		if t == "" {
			t = strs["en"][key]
		}
	}
	if len(a) == 0 {
		return t
	}
	return fmt.Sprintf(t, a...)
}
