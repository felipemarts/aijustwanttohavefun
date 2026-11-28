package playkit

import (
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// Playkit v2: code decides survival, navigation and what is on the menu; the model chooses among a short menu and
// supplies personality and speech. README, section 10.

// PlannerConfig mirrors playkit.json "planner".
type PlannerConfig struct {
	MenuSize           int      `json:"menuSize"`
	OwnerMenuSize      int      `json:"ownerMenuSize"`
	FleeBelow          float64  `json:"fleeBelow"`
	RecoverBelow       float64  `json:"recoverBelow"`
	PotionBelow        float64  `json:"potionBelow"`
	RecoverWaitSeconds int      `json:"recoverWaitSeconds"`
	HealingItems       []string `json:"healingItems"`
	HealSkills         []string `json:"healSkills"`
	RestFlag           string   `json:"restFlag"`
	VisitWindow        int      `json:"visitWindow"`
	VisitMax           int      `json:"visitMax"`
	Deaths             int      `json:"deaths"`
	SafeAccepts        []string `json:"safeAccepts"`
	Fallback           string   `json:"fallback"`
}

// SpeechConfig mirrors playkit.json "speech".
type SpeechConfig struct {
	Actions        []string            `json:"actions"`
	Remember       int                 `json:"remember"`
	Similar        float64             `json:"similar"`
	Opener         int                 `json:"opener"`
	MaxUnanswered  int                 `json:"maxUnanswered"`
	QuietTurns     int                 `json:"quietTurns"`
	AddressedTurns int                 `json:"addressedTurns"`
	PromptAfter    int                 `json:"promptAfter"`
	Examples       map[string][]string `json:"examples"`
	PoliteMarkers  []string            `json:"politeMarkers"`
}

// voice ends every speech label: the crude voice where the model writes the text, with a tone example that rotates
// with the number of lines said; for a polite persona, "as your persona speaks". Copying an example is refused.
func (p *planner) voice() string {
	if p.k.Polite(p.in.Character.Persona) {
		return "as your persona speaks"
	}
	ex := p.k.VoiceExamples(p.in.Character.Language)
	if len(ex) == 0 {
		return "swearing like a tavern regular"
	}
	return "swearing like a tavern regular (tone, do not copy: " + jv.Quote(ex[len(p.in.Memory.Said)%len(ex)]) + ")"
}

// VoiceExamples are the tone examples for a language: the exact tag, else the first tag (sorted) with the same
// primary subtag, else English.
func (k *Kit) VoiceExamples(tag string) []string {
	if e, ok := k.Speech.Examples[tag]; ok {
		return e
	}
	primary, _, _ := strings.Cut(tag, "-")
	var tags []string
	for t := range k.Speech.Examples {
		tags = append(tags, t)
	}
	sort.Strings(tags)
	for _, t := range tags {
		if p, _, _ := strings.Cut(t, "-"); p == primary {
			return k.Speech.Examples[t]
		}
	}
	return k.Speech.Examples["en"]
}

// Polite reports whether the persona asks for a clean voice: it contains a polite marker (lower-cased).
func (k *Kit) Polite(persona string) bool {
	low := strings.ToLower(persona)
	for _, m := range k.Speech.PoliteMarkers {
		if strings.Contains(low, m) {
			return true
		}
	}
	return false
}

// WorldMap is the static map from GET /api/public/world: every room's zone, flags and exits.
type WorldMap struct {
	Order []string           `json:"order"`
	Rooms map[string]MapRoom `json:"rooms"`
}

type MapRoom struct {
	Zone  string      `json:"zone"`
	Flags []string    `json:"flags"`
	Exits [][2]string `json:"exits"`
}

// ParseWorldMap reads the body of GET /api/public/world (only `rooms` is used), keeping the order of rooms and exits.
func ParseWorldMap(body string) (*WorldMap, error) {
	v, err := jv.Parse(body)
	if err != nil {
		return nil, err
	}
	rooms, _ := v.Get("rooms")
	m := &WorldMap{Rooms: map[string]MapRoom{}}
	for _, r := range rooms.A {
		id := str(r, "id")
		if id == "" {
			continue
		}
		flags, _ := r.Get("flags")
		exits, _ := r.Get("exits")
		mr := MapRoom{Zone: str(r, "zone"), Flags: strList(flags)}
		for _, e := range exits.O {
			mr.Exits = append(mr.Exits, [2]string{e.Key, e.Val.Text()})
		}
		m.Order = append(m.Order, id)
		m.Rooms[id] = mr
	}
	return m, nil
}

// Death is where and why the character fell.
type Death struct {
	Room  string `json:"room"`
	Level int    `json:"level"`
	Cause string `json:"cause"`
}

// Addressed is a line another agent addressed to the character, waiting for a reply.
type Addressed struct {
	From string `json:"from"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	Age  int    `json:"age"`
}

// Speech counts the character's talk: Unanswered utterances since another agent last spoke, Quiet turns since it
// last spoke.
type Speech struct {
	Unanswered int `json:"unanswered"`
	Quiet      int `json:"quiet"`
}

// ── the map: graph, safety, routes ──────────────────────────────────────────────────────────────────────────────

type nav struct {
	k     *Kit
	obs   jv.Value
	w     World
	m     *WorldMap
	mem   *Memory
	lvl   int
	here  string
	order []string
}

func (k *Kit) newNav(obs jv.Value, mem *Memory, m *WorldMap) *nav {
	you, _ := obs.Get("you")
	lvl, _ := you.Get("lvl")
	n := &nav{k: k, obs: obs, w: mem.World, m: m, mem: mem, lvl: int(lvl.N), here: str(jvRoom(obs), "id")}
	if m != nil {
		n.order = m.Order
	}
	return n
}

// exits of a room: the current observation for the current room, else what the character saw there, else the
// public map.
func (n *nav) exits(room string) [][2]string {
	if room == n.here {
		ex, _ := jvRoom(n.obs).Get("exits")
		var out [][2]string
		for _, e := range ex.O {
			out = append(out, [2]string{e.Key, e.Val.Text()})
		}
		return out
	}
	if e, ok := n.w.Rooms[room]; ok {
		return e
	}
	if n.m != nil {
		return n.m.Rooms[room].Exits
	}
	return nil
}

// Unsafe: a room whose known monsters are more than monsterLevelGap above the character, or where it died at its
// current level or above.
func (n *nav) Unsafe(room string) bool {
	if d, ok := n.w.Danger[room]; ok && d > n.lvl+n.k.Lim("monsterLevelGap") {
		return true
	}
	for _, d := range n.mem.Deaths {
		if d.Room == room && d.Level >= n.lvl {
			return true
		}
	}
	return false
}

func (n *nav) visits(room string) int {
	c := 0
	for _, v := range n.mem.Visits {
		if v == room {
			c++
		}
	}
	return c
}

// route is the shortest way from here to `to` through rooms that are not unsafe (the destination included),
// breadth-first, exits in their listed order; with avoidBusy, rooms visited visitMax times in the window are not
// entered either. nil when there is none or when already there.
func (n *nav) route(to string, avoidBusy bool) []string {
	if to == n.here || to == "" || n.Unsafe(to) {
		return nil
	}
	type step struct {
		room string
		dirs []string
	}
	seen := map[string]bool{n.here: true}
	queue := []step{{n.here, nil}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, e := range n.exits(cur.room) {
			if seen[e[1]] || n.Unsafe(e[1]) || (avoidBusy && e[1] != to && n.visits(e[1]) >= n.k.Planner.VisitMax) {
				continue
			}
			dirs := append(append([]string{}, cur.dirs...), e[0])
			if e[1] == to {
				return dirs
			}
			seen[e[1]] = true
			queue = append(queue, step{e[1], dirs})
		}
	}
	return nil
}

// frontier is the way to the nearest room never visited (not in World.Rooms), avoiding unsafe and busy rooms.
func (n *nav) frontier() ([]string, string) {
	type step struct {
		room string
		dirs []string
	}
	seen := map[string]bool{n.here: true}
	queue := []step{{n.here, nil}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, e := range n.exits(cur.room) {
			if seen[e[1]] || n.Unsafe(e[1]) || n.visits(e[1]) >= n.k.Planner.VisitMax {
				continue
			}
			dirs := append(append([]string{}, cur.dirs...), e[0])
			if _, known := n.w.Rooms[e[1]]; !known {
				return dirs, e[1]
			}
			seen[e[1]] = true
			queue = append(queue, step{e[1], dirs})
		}
	}
	return nil, ""
}

// Words splits text into lower-cased words: maximal runs of Unicode letters and digits.
func Words(s string) []string {
	var out []string
	var b strings.Builder
	flush := func() {
		if b.Len() > 0 {
			out = append(out, b.String())
			b.Reset()
		}
	}
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return out
}

// placeIn finds the room a text names: among the map's rooms (map order), those whose id words (split on `.` and
// `_`) all appear in the text; the one with the most words wins, the first on a tie (the current room included).
// "" when none.
func (n *nav) placeIn(text string) string {
	words := map[string]bool{}
	for _, w := range Words(text) {
		words[w] = true
	}
	best, score := "", 0
	for _, id := range n.order {
		parts := Words(id)
		ok := len(parts) > 0
		for _, p := range parts {
			ok = ok && words[p]
		}
		if ok && len(parts) > score {
			best, score = id, len(parts)
		}
	}
	return best
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────

// Plan is the planner's result: the mode, the curated menu, the next-step text, and End (a reason to end the
// session instead of asking the model, when there is nothing safe to do).
type Plan struct {
	Mode string
	Menu []MenuAction
	Next string
	End  string
	Lost bool
}

type planner struct {
	k     *Kit
	base  Menu
	obs   jv.Value
	me    jv.Value
	in    TurnInput
	nav   *nav
	opts  []MenuAction
	limit int
	lost  bool
}

func hpFrac(obs jv.Value) float64 {
	you, _ := obs.Get("you")
	hp, _ := you.Get("hp")
	if hp.Kind != jv.Array || len(hp.A) != 2 || hp.A[1].N <= 0 {
		return 1
	}
	return hp.A[0].N / hp.A[1].N
}

// fix makes an option from a base action: each param in `set` gets an enum of the given values, intersected with
// the base enum when there is one (the planner never widens the menu). false when the action is not on the base
// menu, a param is missing, or an intersection is empty.
func (p *planner) fix(action string, set [][2]any, label string) (MenuAction, bool) {
	base, ok := p.base.findOne(action)
	if !ok {
		return MenuAction{}, false
	}
	params := base.Params.Clone()
	if params.Has("anyOf") {
		// cast with PvP off: the form whose skill enum holds the first wanted skill.
		forms, _ := params.Get("anyOf")
		var chosen *jv.Value
		for i := range forms.A {
			props, _ := forms.A[i].Get("properties")
			sk, _ := props.Get("skill")
			en, _ := sk.Get("enum")
			for _, s := range set {
				if s[0] == "skill" {
					for _, v := range s[1].([]string) {
						for _, e := range en.A {
							if e.Text() == v && chosen == nil {
								f := forms.A[i]
								chosen = &f
							}
						}
					}
				}
			}
		}
		if chosen == nil {
			return MenuAction{}, false
		}
		params = chosen.Clone()
	}
	props, _ := params.Get("properties")
	for _, s := range set {
		name, vals := s[0].(string), s[1].([]string)
		node, has := props.Get(name)
		if !has {
			return MenuAction{}, false
		}
		if en, ok := node.Get("enum"); ok {
			var kept []string
			for _, v := range vals {
				for _, e := range en.A {
					if e.Text() == v && !contains(kept, v) {
						kept = append(kept, v)
					}
				}
			}
			vals = kept
		}
		if len(vals) == 0 {
			return MenuAction{}, false
		}
		props.Set(name, jv.Obj("type", jv.Str("string"), "enum", jv.StrArr(vals)))
	}
	params.Set("properties", props)
	return MenuAction{Name: action, AP: base.AP, Params: params, Signatures: []string{Signature(action, params)}, Label: label}, true
}

func (m *Menu) findOne(name string) (MenuAction, bool) {
	for _, a := range m.Actions {
		if a.Name == name {
			return a, true
		}
	}
	return MenuAction{}, false
}

func (p *planner) add(o MenuAction, ok bool) bool {
	if !ok || len(p.opts) >= p.limit {
		return false
	}
	for _, x := range p.opts {
		if x.Name == o.Name && Write(x.Params) == Write(o.Params) {
			return false
		}
	}
	p.opts = append(p.opts, o)
	return true
}

// Write is jv.Write, for comparing schemas.
func Write(v jv.Value) string { return jv.Write(v) }

func (p *planner) has(action string) bool {
	for _, o := range p.opts {
		if o.Name == action {
			return true
		}
	}
	return false
}

// bag lists the inventory ids (qty > 0) among `want`, in `want` order.
func (p *planner) bag(want []string) []string {
	inv, _ := p.me.Get("inventory")
	var out []string
	for _, w := range want {
		if q, ok := inv.Get(w); ok && q.N > 0 {
			out = append(out, w)
		}
	}
	return out
}

func (p *planner) skills(supportive bool, only []string) []string {
	sk, _ := p.me.Get("skills")
	you, _ := p.obs.Get("you")
	mp, _ := you.Get("mp")
	var out []string
	for _, s := range sk.A {
		if l, _ := s.Get("locked"); l.Kind == jv.Bool && l.B {
			continue
		}
		cost, _ := s.Get("mp")
		if mp.Kind == jv.Array && len(mp.A) == 2 && cost.N > mp.A[0].N {
			continue
		}
		id := str(s, "id")
		sup := contains(p.k.SupportiveSkillTargets, str(s, "target"))
		if sup != supportive || (only != nil && !contains(only, id)) {
			continue
		}
		out = append(out, id)
	}
	return out
}

func (p *planner) moveTo(dirs []string, label string) (MenuAction, bool) {
	if len(dirs) == 0 {
		return MenuAction{}, false
	}
	return p.fix("move", [][2]any{{"dir", []string{dirs[0]}}}, label)
}

func way(dirs []string) string {
	if len(dirs) <= 1 {
		return ""
	}
	return " (way: " + joinList(dirs) + ")"
}

// goTowards: an option and text to go to a room by the safest shortest way.
func (p *planner) goTowards(room, why string) (MenuAction, bool, string) {
	dirs := p.nav.route(room, false)
	if dirs == nil {
		return MenuAction{}, false, ""
	}
	text := "go to " + room + way(dirs) + why
	o, ok := p.moveTo(dirs, "next step")
	return o, ok, text
}

// next computes the step the quests need as one concrete option (params fixed) and its text.
func (p *planner) next() (MenuAction, bool, string) {
	obs, me, n := p.obs, p.me, p.nav
	told := func(id string) string {
		for _, t := range p.in.Memory.Told {
			if t.Quest == id {
				return t.Text
			}
		}
		return ""
	}
	explore := func(why string) (MenuAction, bool, string) {
		dirs, room := n.frontier()
		if dirs == nil {
			p.lost = true
			return MenuAction{}, false, why + "; nowhere new to explore nearby"
		}
		text := why + ": explore toward " + room + way(dirs)
		o, ok := p.moveTo(dirs, "next step")
		return o, ok, text
	}
	if q, ok := obs.Get("quest"); ok && q.Kind == jv.Object {
		room, id, giver := str(q, "room"), str(q, "id"), str(q, "giver")
		switch str(q, "state") {
		case "offer":
			if room == n.here {
				o, ok := p.fix("quest_accept", [][2]any{{"quest", []string{id}}}, "next step: accept "+id+" from "+giver)
				return o, ok, "quest_accept " + id + " (" + giver + " is here)."
			}
			return p.goTowards(room, ", then talk to "+giver+" and quest_accept "+id+".")
		case "ready":
			if room == n.here {
				o, ok := p.fix("quest_turn_in", [][2]any{{"quest", []string{id}}}, "next step: hand in "+id+" to "+giver)
				return o, ok, "quest_turn_in " + id + " (" + giver + " is here)."
			}
			return p.goTowards(room, ", then quest_turn_in "+id+" to "+giver+".")
		}
	}
	if me.Kind != jv.Object {
		return MenuAction{}, false, ""
	}
	qs, _ := me.Get("quests")
	for _, q := range qs.A {
		if r, _ := q.Get("ready"); r.Kind == jv.Bool && r.B {
			id, giver := str(q, "id"), str(q, "giver")
			if inRoom(obs, "npcs", giver) {
				o, ok := p.fix("quest_turn_in", [][2]any{{"quest", []string{id}}}, "next step: hand in "+id+" to "+giver)
				return o, ok, "quest_turn_in " + id + " (" + giver + " is here)."
			}
			if r, ok := n.w.NPCs[giver]; ok {
				return p.goTowards(r, ", then quest_turn_in "+id+" to "+giver+".")
			}
			return MenuAction{}, false, "quest_turn_in " + id + " to " + giver + "."
		}
	}
	for _, q := range qs.A {
		id := str(q, "id")
		steps, _ := q.Get("steps")
		for _, s := range steps.A {
			have, _ := s.Get("have")
			need, _ := s.Get("need")
			if have.N >= need.N {
				continue
			}
			do, target := str(s, "do"), str(s, "target")
			tag := " (quest " + id + ", " + jv.FormatNumber(have.N) + "/" + jv.FormatNumber(need.N) + ")."
			elsewhere := func(known string, then string) (MenuAction, bool, string) {
				if known == "" {
					known = n.placeIn(told(id))
				}
				if known != "" && known != n.here {
					if o, ok, text := p.goTowards(known, ", then "+then+tag); ok {
						return o, ok, text
					}
				}
				if known == n.here && do != "talk" {
					// The quest's place is here: stay. Fight what is here (drops, XP) or wait for it to come back.
					if fair, _ := Source("fair_monsters", obs, me); len(fair) > 0 {
						o, ok := p.fix("attack", [][2]any{{"target", fair}}, "next step: fight here (for "+target+")")
						if ok {
							return o, ok, "you are where the quest sends you: fight here for " + target + tag
						}
					}
					o, ok := p.fix(p.k.Planner.Fallback, nil, "next step: wait here for "+target+" to come back")
					return o, ok, "you are where the quest sends you: wait here, " + target + " comes back soon" + tag
				}
				return explore("find " + target + " for quest " + id)
			}
			switch do {
			case "visit":
				if target == n.here {
					continue
				}
				o, ok, text := p.goTowards(target, tag)
				if ok {
					return o, ok, text
				}
				p.lost = true
				return MenuAction{}, false, "go to " + target + tag
			case "talk":
				if inRoom(obs, "npcs", target) {
					o, ok := p.fix("talk", [][2]any{{"npc", []string{target}}}, "next step: talk to "+target)
					return o, ok, "talk to " + target + tag
				}
				return elsewhere(n.w.NPCs[target], "talk to "+target)
			case "kill":
				if inRoom(obs, "monsters", target) {
					o, ok := p.fix("attack", [][2]any{{"target", []string{target}}}, "next step: fight "+target)
					if ok {
						return o, ok, "attack " + target + tag
					}
					return MenuAction{}, false, target + " is too strong for you here; grow stronger first."
				}
				return elsewhere(n.w.Monsters[target], "attack "+target)
			case "gather", "collect":
				if r, _ := jvRoom(obs).Get("resources"); r.Has(target) {
					o, ok := p.fix("gather", [][2]any{{"resource", []string{target}}}, "next step: gather "+target)
					if ok {
						return o, ok, "gather " + target + tag
					}
				}
				if it, _ := jvRoom(obs).Get("items"); it.Has(target) {
					o, ok := p.fix("take", [][2]any{{"item", []string{target}}}, "next step: take "+target)
					if ok {
						return o, ok, "take " + target + tag
					}
				}
				return elsewhere("", "gather "+target)
			case "equip":
				o, ok := p.fix("equip", [][2]any{{"item", []string{target}}}, "next step: equip "+target)
				return o, ok, "equip " + target + tag
			case "shop_buy":
				if shops, _ := Source("shops", obs, me); len(shops) > 0 {
					o, ok := p.fix("shop_buy", [][2]any{{"npc", shops}, {"item", []string{target}}}, "next step: buy "+target)
					return o, ok, "shop_buy " + target + tag
				}
			}
			tpl, ok := p.k.StepHints[do]
			if !ok {
				tpl = do + " {target}"
			}
			return MenuAction{}, false, TrimSpace(strings.NewReplacer("{target}", target, "{need}", jv.FormatNumber(need.N)).Replace(tpl)) + tag
		}
	}
	return explore("no quest step to do here")
}

// speechAllowed: someone else is here, the character is claimed, and it has not been talking to no answer.
func (p *planner) speechAllowed() bool {
	agents, _ := jvRoom(p.obs).Get("agents")
	if len(agents.A) == 0 {
		return false
	}
	if cl, ok := p.me.Get("agent"); ok {
		if c, ok := cl.Get("claimed"); ok && c.Kind == jv.Bool && !c.B {
			return false
		}
	}
	sp := p.in.Memory.Speech
	return sp.Unanswered < p.k.Speech.MaxUnanswered || sp.Quiet >= p.k.Speech.QuietTurns
}

// reply: the option answering the agent who addressed the character, with their line under it.
func (p *planner) reply() (MenuAction, bool) {
	a := p.in.Memory.Addressed
	if a == nil {
		return MenuAction{}, false
	}
	line := Plain(a.From, p.k.Lim("nameText")) + " (" + Plain(a.Kind, 20) + "): " + Quoted(a.Text, p.k.Lim("chatText"))
	var o MenuAction
	var ok bool
	label := "reply to " + Plain(a.From, p.k.Lim("nameText")) + " in " + p.k.LanguageName(p.in.Character.Language) + ", " + p.voice() + "; they said:"
	if a.Kind == "whisper" {
		o, ok = p.fix("whisper", [][2]any{{"to", []string{a.From}}}, label)
	} else {
		o, ok = p.base.findOne("say")
		o.Label = label
	}
	o.Chat = line
	return o, ok
}

// BuildPlan is the v2 planner (README 10.2): from the legal menu (v1 rules) to the curated one.
func (k *Kit) BuildPlan(base Menu, in TurnInput) Plan {
	obs, me := in.Observation, in.Me
	p := &planner{k: k, base: base, obs: obs, me: me, in: in, nav: k.newNav(obs, &in.Memory, in.Map), limit: k.Planner.MenuSize}
	you, _ := obs.Get("you")
	frac := hpFrac(obs)
	fight := str(you, "in_combat")
	self := []string{in.Character.Name}
	heal := p.bag(k.Planner.HealingItems)
	switch {
	case you.Has("fallen"):
		p.add(p.fix("release", nil, "wake at the temple"))
		return Plan{Mode: "fallen", Menu: p.opts}
	case fight != "" && (frac < k.Planner.FleeBelow || p.outclassed(fight)):
		p.add(p.fix("use", [][2]any{{"item", heal}}, "heal now, HP is low"))
		if hs := p.skills(true, k.Planner.HealSkills); len(hs) > 0 {
			p.add(p.fix("cast", [][2]any{{"skill", hs}, {"target", self}}, "heal yourself"))
		}
		p.add(p.fix("flee", nil, "escape this fight"))
		if frac >= k.Planner.FleeBelow {
			return Plan{Mode: "survive", Menu: p.opts, Next: fight + " is far too strong for you: flee."}
		}
		return Plan{Mode: "survive", Menu: p.opts, Next: "your HP is low: heal or flee."}
	case fight != "":
		p.add(p.fix("attack", [][2]any{{"target", []string{fight}}}, "keep fighting "+fight))
		if off := p.skills(false, nil); len(off) > 0 {
			p.add(p.fix("cast", [][2]any{{"skill", off}, {"target", []string{fight}}}, "use a skill on "+fight))
		}
		if frac < k.Planner.PotionBelow {
			p.add(p.fix("use", [][2]any{{"item", heal}}, "heal"))
		}
		p.add(p.fix("flee", nil, "escape this fight"))
		return Plan{Mode: "fight", Menu: p.opts, Next: "finish the fight with " + fight + "."}
	case frac < k.Planner.RecoverBelow:
		if o, ok := p.reply(); ok {
			p.add(o, ok)
		}
		p.add(p.fix("rest", nil, "recover HP and MP for a little gold"))
		p.add(p.fix("use", [][2]any{{"item", heal}}, "heal"))
		text := ""
		if !p.has("rest") {
			if room := p.restRoom(); room != "" {
				if dirs := p.nav.route(room, false); dirs != nil {
					text = " Go rest at " + room + way(dirs) + "."
					p.add(p.moveTo(dirs, "recover: go to "+room))
				}
			}
		}
		if len(p.opts) == 0 || (len(p.opts) == 1 && p.opts[0].Chat != "") {
			return Plan{Mode: "recover", Menu: p.opts, End: "recover"}
		}
		return Plan{Mode: "recover", Menu: p.opts, Next: "your HP is low: recover before anything else." + text}
	}
	owner := TrimSpace(in.Command) != ""
	if owner {
		p.limit = k.Planner.OwnerMenuSize
	}
	lang := k.LanguageName(in.Character.Language)
	talkFirst := ""
	if o, ok := p.reply(); ok && p.add(o, ok) {
		talkFirst = "reply to " + Plain(in.Memory.Addressed.From, k.Lim("nameText")) + " first; then "
	} else if p.speechAllowed() && p.in.Memory.Speech.Quiet >= k.Speech.PromptAfter {
		// A quiet character with company gets its turn to talk first (its voice is half the show).
		o, ok := p.base.findOne("say")
		o.Label = "you have been quiet: say something to " + p.names() + " in " + lang + ", " + p.voice() + " (name who you talk to)"
		if p.add(o, ok) {
			talkFirst = "say something to " + p.names() + " first; then "
		}
	}
	o, ok, nextText := p.next()
	hasNext := p.add(o, ok)
	if talkFirst != "" && nextText != "" {
		nextText = talkFirst + nextText
	}
	for _, a := range k.Planner.SafeAccepts {
		if p.add(p.base.findOne(a)) {
			break
		}
	}
	// With a concrete next step on the menu, no fight for XP and no exploring next to it: small models take the
	// detour.
	if fair, _ := Source("fair_monsters", obs, me); len(fair) > 0 && !p.has("attack") && !hasNext {
		p.add(p.fix("attack", [][2]any{{"target", fair}}, "fight for XP"))
	}
	if p.speechAllowed() && !p.has("say") {
		o, ok := p.base.findOne("say")
		o.Label = "talk to the people here: " + p.names() + ", in " + lang + ", " + p.voice() + " (name who you talk to)"
		p.add(o, ok)
	}
	if !p.has("move") && !hasNext {
		if dirs, room := p.nav.frontier(); dirs != nil {
			p.add(p.moveTo(dirs, "explore toward "+room+way(dirs)))
		}
	}
	if owner {
		// The owner's wish may need anything legal: the rest of the legal menu, moves limited to safe exits.
		for _, a := range base.Actions {
			if a.Name == "move" {
				var safe []string
				exits, _ := jvRoom(obs).Get("exits")
				for _, e := range exits.O {
					if !p.nav.Unsafe(e.Val.Text()) {
						safe = append(safe, e.Key)
					}
				}
				p.add(p.fix("move", [][2]any{{"dir", safe}}, "go somewhere"))
				continue
			}
			if !p.has(a.Name) {
				p.add(a, true)
			}
		}
	}
	if !hasNext || len(p.opts) == 0 {
		if fb, ok := p.base.findOne(k.Planner.Fallback); ok && !p.has(fb.Name) {
			if len(p.opts) >= p.limit {
				p.opts = p.opts[:p.limit-1]
			}
			fb.Label = "look over your quests"
			p.opts = append(p.opts, fb)
		}
	}
	return Plan{Mode: "normal", Menu: p.opts, Next: nextText, Lost: p.lost}
}

func (p *planner) names() string {
	agents, _ := jvRoom(p.obs).Get("agents")
	var names []string
	for _, a := range agents.A {
		names = append(names, Plain(str(a, "name"), p.k.Lim("nameText")))
	}
	return joinList(names)
}

// outclassed: the monster being fought is listed in the room more than monsterLevelGap levels above the character.
func (p *planner) outclassed(fight string) bool {
	ms, _ := jvRoom(p.obs).Get("monsters")
	you, _ := p.obs.Get("you")
	lvl, _ := you.Get("lvl")
	for _, m := range ms.A {
		if str(m, "id") == fight {
			ml, _ := m.Get("lvl")
			return ml.N > lvl.N+float64(p.k.Lim("monsterLevelGap"))
		}
	}
	return false
}

// restRoom is the nearest room (by route) whose public flags include restFlag.
func (p *planner) restRoom() string {
	if p.nav.m == nil {
		return ""
	}
	best, bestLen := "", -1
	for _, id := range p.nav.m.Order {
		if !contains(p.nav.m.Rooms[id].Flags, p.k.Planner.RestFlag) {
			continue
		}
		if id == p.nav.here {
			return id
		}
		if d := p.nav.route(id, false); d != nil && (bestLen < 0 || len(d) < bestLen) {
			best, bestLen = id, len(d)
		}
	}
	return best
}

// ── memory upkeep for v2 ────────────────────────────────────────────────────────────────────────────────────────

// StuckConfig mirrors playkit.json "stuck".
type StuckConfig struct {
	Window          int      `json:"window"`
	Refused         int      `json:"refused"`
	NoProgressTurns int      `json:"noProgressTurns"`
	LostTurns       int      `json:"lostTurns"`
	ProgressActions []string `json:"progressActions"`
}

// StuckReason says why the character makes no progress (10.8): "refusals", "lost", "no_progress", or "".
func (k *Kit) StuckReason(m Memory) string {
	st := k.Config.Stuck
	if len(m.Outcomes) >= st.Window {
		refused := 0
		for _, ok := range m.Outcomes {
			if !ok {
				refused++
			}
		}
		if refused >= st.Refused {
			return "refusals"
		}
	}
	if m.Lost >= st.LostTurns {
		return "lost"
	}
	if m.NoProgress >= st.NoProgressTurns {
		return "no_progress"
	}
	return ""
}

// Update is what happened in a turn, for Track.
type Update struct {
	Before, After jv.Value // the merged observations before and after the action
	Action        string
	Params        jv.Value
	OK            bool
	Chat          []ChatLine // lines heard with the response
	Self          string
	Lost          bool // the planner was lost this turn (Turn.Lost)
}

// Track keeps the v2 memory (README 10.4): visits, deaths, speech, who addressed the character.
func (k *Kit) Track(m *Memory, u Update) {
	pl, sp := k.Planner, k.Speech
	before, after := jvRoom(u.Before), jvRoom(u.After)
	if id := str(after, "id"); id != "" && id != str(before, "id") {
		m.Visits = append(m.Visits, id)
		if len(m.Visits) > pl.VisitWindow {
			m.Visits = append([]string(nil), m.Visits[len(m.Visits)-pl.VisitWindow:]...)
		}
	}
	yb, _ := u.Before.Get("you")
	ya, _ := u.After.Get("you")
	if ya.Has("fallen") && !yb.Has("fallen") {
		cause := str(yb, "in_combat")
		if cause == "" {
			cause = str(u.Params, "target")
		}
		lvl, _ := ya.Get("lvl")
		m.Deaths = append(m.Deaths, Death{Room: str(after, "id"), Level: int(lvl.N), Cause: cause})
		if len(m.Deaths) > pl.Deaths {
			m.Deaths = append([]Death(nil), m.Deaths[len(m.Deaths)-pl.Deaths:]...)
		}
	}
	if u.Action != "look" {
		st := k.Config.Stuck
		m.Outcomes = append(m.Outcomes, u.OK)
		if len(m.Outcomes) > st.Window {
			m.Outcomes = append([]bool(nil), m.Outcomes[len(m.Outcomes)-st.Window:]...)
		}
		progress := u.OK && contains(st.ProgressActions, u.Action)
		for _, key := range []string{"lvl", "gold"} {
			b, _ := yb.Get(key)
			a, _ := ya.Get(key)
			progress = progress || (a.Kind == jv.Number && b.Kind == jv.Number && a.N != b.N)
		}
		for _, key := range []string{"xp", "bag"} {
			b, _ := yb.Get(key)
			a, _ := ya.Get(key)
			if len(a.A) > 0 && len(b.A) > 0 && a.A[0].N != b.A[0].N {
				progress = true
			}
		}
		if progress {
			m.NoProgress = 0
		} else {
			m.NoProgress++
		}
		if u.Lost {
			m.Lost++
		} else {
			m.Lost = 0
		}
	}
	m.Speech.Quiet++
	if m.Addressed != nil {
		m.Addressed.Age++
		if m.Addressed.Age > sp.AddressedTurns {
			m.Addressed = nil
		}
	}
	if u.OK && contains(sp.Actions, u.Action) {
		m.Said = append(m.Said, str(u.Params, "text"))
		if len(m.Said) > sp.Remember {
			m.Said = append([]string(nil), m.Said[len(m.Said)-sp.Remember:]...)
		}
		m.Speech.Unanswered++
		m.Speech.Quiet = 0
		m.Addressed = nil
	}
	self := strings.ToLower(u.Self)
	for _, c := range u.Chat {
		if strings.EqualFold(c.From, u.Self) {
			continue
		}
		m.Speech.Unanswered = 0
		direct := c.Kind == "whisper" || c.Kind == "party_say"
		if direct || (self != "" && strings.Contains(strings.ToLower(c.Text), self)) {
			m.Addressed = &Addressed{From: c.From, Kind: c.Kind, Text: c.Text}
		}
	}
}

// Similar reports whether two utterances are too close: equal word lists, or a Jaccard index of their word sets
// at or above speech.similar.
func (k *Kit) Similar(a, b string) bool {
	wa, wb := Words(a), Words(b)
	if strings.Join(wa, " ") == strings.Join(wb, " ") {
		return true
	}
	sa, sb := map[string]bool{}, map[string]bool{}
	for _, w := range wa {
		sa[w] = true
	}
	for _, w := range wb {
		sb[w] = true
	}
	inter, union := 0, len(sb)
	for w := range sa {
		if sb[w] {
			inter++
		} else {
			union++
		}
	}
	if union == 0 {
		return true
	}
	return float64(inter)/float64(union) >= k.Speech.Similar
}

// SameOpener reports whether two utterances open alike: both have at least speech.opener words and their first
// speech.opener words are equal. A small model repeats one catchphrase at the start of every line, which Similar
// misses when the rest differs.
func (k *Kit) SameOpener(a, b string) bool {
	n := k.Speech.Opener
	wa, wb := Words(a), Words(b)
	if n <= 0 || len(wa) < n || len(wb) < n {
		return false
	}
	return strings.Join(wa[:n], " ") == strings.Join(wb[:n], " ")
}

func (k *Kit) tooSimilar(d Decision, said []string) string {
	if !contains(k.Speech.Actions, d.Action) {
		return ""
	}
	text := str(d.Params, "text")
	for _, s := range said {
		if k.Similar(text, s) {
			return "params.text: too close to something you said recently; say something new"
		}
	}
	for _, s := range said {
		if k.SameOpener(text, s) {
			return "params.text: starts like something you said recently; open with different words"
		}
	}
	return ""
}

var _ = fmt.Sprintf
