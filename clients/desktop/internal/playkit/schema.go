package playkit

import (
	"fmt"
	"strings"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// ActionShape is one entry of GET /api/v1/schema.
type ActionShape struct {
	Name      string
	AP        int
	Signature string
	Params    jv.Value
}

// SchemaDoc is GET /api/v1/schema, parsed with member order kept.
type SchemaDoc struct {
	APIVersion   string
	SkillVersion string
	Actions      []ActionShape
	byName       map[string]int
}

// ParseSchemaDoc reads the body of GET /api/v1/schema.
func ParseSchemaDoc(body string) (*SchemaDoc, error) {
	v, err := jv.Parse(body)
	if err != nil {
		return nil, err
	}
	d := &SchemaDoc{byName: map[string]int{}}
	av, _ := v.Get("api_version")
	sv, _ := v.Get("skill_version")
	d.APIVersion, d.SkillVersion = av.Text(), sv.Text()
	acts, ok := v.Get("actions")
	if !ok || acts.Kind != jv.Array {
		return nil, fmt.Errorf("schema: no actions")
	}
	for _, a := range acts.A {
		name, _ := a.Get("name")
		ap, _ := a.Get("ap")
		sig, _ := a.Get("signature")
		params, ok := a.Get("params")
		if name.Kind != jv.String || !ok || params.Kind != jv.Object {
			return nil, fmt.Errorf("schema: bad action entry")
		}
		d.byName[name.S] = len(d.Actions)
		d.Actions = append(d.Actions, ActionShape{Name: name.S, AP: int(ap.N), Signature: sig.Text(), Params: params})
	}
	return d, nil
}

// Get finds an action by name.
func (d *SchemaDoc) Get(name string) (ActionShape, bool) {
	i, ok := d.byName[name]
	if !ok {
		return ActionShape{}, false
	}
	return d.Actions[i], true
}

// Menu is what the model may choose from this turn: the allowed actions in order, each with its narrowed params
// schema, plus the decision schema built from them.
type Menu struct {
	Actions []MenuAction
	Schema  jv.Value
	// Said (v2): the character's last utterances; a new one too close to any of them is refused.
	Said []string
}

type MenuAction struct {
	Name   string
	AP     int
	Params jv.Value
	// Signatures: one line per form of the params (two for cast when supportive and offensive skills differ).
	Signatures []string
	// Label (v2): why the planner offers it, shown after the AP cost; Chat: a quoted line shown under it.
	Label string
	Chat  string
}

// Find returns the menu entry for an action. When the menu offers the action more than once (v2: the same action
// with different fixed params), the params of all its entries are merged as {"anyOf": [...]}, in menu order.
func (m *Menu) Find(name string) (MenuAction, bool) {
	var found []MenuAction
	for _, a := range m.Actions {
		if a.Name == name {
			found = append(found, a)
		}
	}
	switch len(found) {
	case 0:
		return MenuAction{}, false
	case 1:
		return found[0], true
	}
	forms := jv.Arr()
	for _, f := range found {
		forms.A = append(forms.A, f.Params)
	}
	merged := found[0]
	merged.Params = jv.Obj("anyOf", forms)
	return merged, true
}

// Names lists the allowed action names in order, each once.
func (m *Menu) Names() []string {
	var out []string
	for _, a := range m.Actions {
		if !contains(out, a.Name) {
			out = append(out, a.Name)
		}
	}
	return out
}

// fairGap is limits.monsterLevelGap, set when the kit loads (Source has no kit).
var fairGap = 4

// BuildMenu implements "The menu" in the README: the observation's `actions`, in its order, without duplicates,
// keeping only actions the schema document knows, minus `excludedActions`, minus `pvpActions` unless PvP is allowed;
// each params schema adjusted and narrowed; an action whose required param narrows to nothing is dropped. Then the
// actions in `rest` (this turn's loop breakers) are removed, unless that would leave the menu empty.
func (k *Kit) BuildMenu(doc *SchemaDoc, obs, me jv.Value, allowPvp bool, self string, rest []string) Menu {
	menu := k.buildMenu(doc, obs, me, allowPvp, self)
	if len(rest) > 0 {
		var kept []MenuAction
		for _, a := range menu.Actions {
			if !contains(rest, a.Name) {
				kept = append(kept, a)
			}
		}
		if len(kept) > 0 {
			menu.Actions = kept
		}
	}
	menu.Schema = k.decisionSchema(menu.Actions)
	return menu
}

// Resting returns the loop breakers for a turn: the action refused on the previous turn, then, in order of first
// appearance in `recent`, every 0-AP action that appears at least twice there with the same params (whatever the
// outcome). Small models alternate two free actions forever otherwise.
func Resting(doc *SchemaDoc, last *Last, recent []Recent) []string {
	var out []string
	if last != nil && !last.OK && last.Action != "look" {
		out = append(out, last.Action)
	}
	count := map[string]int{}
	for _, r := range recent {
		count[r.Action+" "+ParamsText(r.Params)]++
	}
	for _, r := range recent {
		if count[r.Action+" "+ParamsText(r.Params)] < 2 || contains(out, r.Action) {
			continue
		}
		if shape, ok := doc.Get(r.Action); ok && shape.AP == 0 {
			out = append(out, r.Action)
		}
	}
	return out
}

func (k *Kit) buildMenu(doc *SchemaDoc, obs, me jv.Value, allowPvp bool, self string) Menu {
	var menu Menu
	actions, _ := obs.Get("actions")
	names := strList(actions)
	you, _ := obs.Get("you")
	if !you.Has("fallen") {
		names = append(names, k.AlwaysOffered...)
	}
	seen := map[string]bool{}
	for _, name := range names {
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		shape, ok := doc.Get(name)
		if !ok || contains(k.ExcludedActions, name) || (!allowPvp && contains(k.PvpActions, name)) {
			continue
		}
		params := k.adjust(shape.Params.Clone())
		k.omit(name, &params)
		if !k.narrow(name, &params, obs, me, allowPvp) {
			continue
		}
		if name == "cast" && !allowPvp {
			var ok bool
			if params, ok = k.castForms(params, obs, me, self); !ok {
				continue
			}
		}
		var sigs []string
		if forms, ok := params.Get("anyOf"); ok {
			for _, f := range forms.A {
				sigs = append(sigs, Signature(name, f))
			}
		} else {
			sigs = []string{Signature(name, params)}
		}
		menu.Actions = append(menu.Actions, MenuAction{Name: name, AP: shape.AP, Params: params, Signatures: sigs})
	}
	return menu
}

// omit deletes the omitParams of an action from its properties, when they are not required.
func (k *Kit) omit(action string, params *jv.Value) {
	props, ok := params.Get("properties")
	if !ok {
		return
	}
	required, _ := params.Get("required")
	for _, o := range k.OmitParams {
		if o.Action != action || !props.Has(o.Param) {
			continue
		}
		req := false
		for _, r := range required.A {
			req = req || r.Text() == o.Param
		}
		if !req {
			props.Delete(o.Param)
		}
	}
	params.Set("properties", props)
}

// adjust removes `default`, caps string maxLength at textMax, closes objects that list properties, and turns
// `items: false` after `prefixItems` into `maxItems`.
func (k *Kit) adjust(v jv.Value) jv.Value {
	switch v.Kind {
	case jv.Array:
		for i := range v.A {
			v.A[i] = k.adjust(v.A[i])
		}
	case jv.Object:
		v.Delete("default")
		for i := range v.O {
			v.O[i].Val = k.adjust(v.O[i].Val)
		}
		if t, _ := v.Get("type"); t.S == "string" {
			if ml, ok := v.Get("maxLength"); ok && ml.N > float64(k.Decision.TextMax) {
				v.Set("maxLength", jv.Int(k.Decision.TextMax))
			}
		}
		if v.Has("properties") && !v.Has("additionalProperties") {
			v.Set("additionalProperties", jv.BoolV(false))
		}
		// `items: false` after `prefixItems` (a fixed-length tuple) is not understood by llama.cpp's grammar
		// converter: say the same with maxItems.
		if it, ok := v.Get("items"); ok && it.Kind == jv.Bool && !it.B {
			if pre, ok := v.Get("prefixItems"); ok && pre.Kind == jv.Array {
				v.Delete("items")
				if mx, ok := v.Get("maxItems"); !ok || mx.N > float64(len(pre.A)) {
					v.Set("maxItems", jv.Int(len(pre.A)))
				}
			}
		}
	}
	return v
}

// Source returns the values a narrowing source offers, and whether the source is known at all (sources read from
// GET /me are unknown until it was fetched; room and pending sources are always known, absent meaning empty).
func Source(from string, obs, me jv.Value) ([]string, bool) {
	room, _ := obs.Get("room")
	var out []string
	add := func(s string) {
		if s != "" && !contains(out, s) {
			out = append(out, s)
		}
	}
	keys := func(v jv.Value, positive bool) {
		for _, m := range v.O {
			if positive && m.Val.Kind == jv.Number && m.Val.N <= 0 {
				continue
			}
			add(m.Key)
		}
	}
	switch from {
	case "exits":
		e, _ := room.Get("exits")
		keys(e, false)
	case "monsters":
		ms, _ := room.Get("monsters")
		for _, m := range ms.A {
			id, _ := m.Get("id")
			add(id.Text())
		}
	case "fair_monsters":
		// The monster already being fought, then the room's monsters at most monsterLevelGap levels above.
		you, _ := obs.Get("you")
		add(str(you, "in_combat"))
		lvl, _ := you.Get("lvl")
		ms, _ := room.Get("monsters")
		for _, m := range ms.A {
			ml, _ := m.Get("lvl")
			if ml.N <= lvl.N+float64(fairGap) {
				add(str(m, "id"))
			}
		}
	case "agents":
		as, _ := room.Get("agents")
		for _, a := range as.A {
			if f, _ := a.Get("fallen"); f.Kind == jv.Bool && f.B {
				continue
			}
			n, _ := a.Get("name")
			add(n.Text())
		}
	case "npcs", "shops":
		ns, _ := room.Get("npcs")
		for _, n := range ns.A {
			roles, _ := n.Get("roles")
			if from == "shops" {
				shop := false
				for _, r := range roles.A {
					shop = shop || r.Text() == "shop"
				}
				if !shop {
					continue
				}
			}
			id, _ := n.Get("id")
			add(id.Text())
		}
	case "resources":
		r, _ := room.Get("resources")
		keys(r, true)
	case "ground":
		r, _ := room.Get("items")
		keys(r, true)
	case "bag":
		if me.Kind != jv.Object {
			return nil, false
		}
		inv, _ := me.Get("inventory")
		keys(inv, true)
	case "equipped":
		if me.Kind != jv.Object {
			return nil, false
		}
		eq, _ := me.Get("equipment")
		for _, m := range eq.O {
			add(m.Val.Text())
		}
	case "skills":
		if me.Kind != jv.Object {
			return nil, false
		}
		sk, _ := me.Get("skills")
		for _, s := range sk.A {
			if l, _ := s.Get("locked"); l.Kind == jv.Bool && l.B {
				continue
			}
			id, _ := s.Get("id")
			add(id.Text())
		}
	default:
		if list, ok := strings.CutPrefix(from, "pending."); ok {
			p, _ := obs.Get("pending")
			vals, _ := p.Get(list)
			for _, x := range vals.A {
				if x.Kind == jv.String {
					add(x.S)
				} else if id, ok := x.Get("id"); ok {
					add(id.Text())
				}
			}
		} else {
			return nil, false
		}
	}
	return out, true
}

func isLawless(obs jv.Value) bool {
	room, _ := obs.Get("room")
	flags, _ := room.Get("flags")
	for _, f := range flags.A {
		if f.Text() == "lawless" {
			return true
		}
	}
	return false
}

// narrow applies the `narrow` rules of one action. False when the action has to be dropped.
func (k *Kit) narrow(action string, params *jv.Value, obs, me jv.Value, allowPvp bool) bool {
	props, ok := params.Get("properties")
	if !ok {
		return true
	}
	required, _ := params.Get("required")
	isReq := func(p string) bool {
		for _, r := range required.A {
			if r.Text() == p {
				return true
			}
		}
		return false
	}
	for _, rule := range k.Narrow {
		if rule.Action != action || !props.Has(rule.Param) {
			continue
		}
		vals, known := Source(rule.From, obs, me)
		if !known {
			continue
		}
		if rule.PvpFrom != "" && allowPvp && isLawless(obs) {
			extra, _ := Source(rule.PvpFrom, obs, me)
			for _, e := range extra {
				if !contains(vals, e) {
					vals = append(vals, e)
				}
			}
		}
		if len(vals) == 0 {
			if isReq(rule.Param) {
				return false
			}
			props.Delete(rule.Param)
			continue
		}
		props.Set(rule.Param, jv.Obj("type", jv.Str("string"), "enum", jv.StrArr(vals)))
	}
	params.Set("properties", props)
	return true
}

// castForms applies the PvP-off rule to cast (README, "The menu"): a skill is supportive when its target in GET /me
// is one of supportiveSkillTargets, else (or when unknown) offensive. Offensive skills may target only monsters here;
// supportive ones the agents here and the character itself. The params become one closed form per kind, in the
// order offensive, supportive (a kind with no skill has no form); none at all drops cast.
func (k *Kit) castForms(params jv.Value, obs, me jv.Value, self string) (jv.Value, bool) {
	props, _ := params.Get("properties")
	skill, hasSkill := props.Get("skill")
	if !hasSkill || !props.Has("target") {
		return params, true
	}
	monsters, _ := Source("fair_monsters", obs, me)
	var offensive, supportive []string
	known := me.Kind == jv.Object
	if known {
		sk, _ := me.Get("skills")
		for _, s := range sk.A {
			if l, _ := s.Get("locked"); l.Kind == jv.Bool && l.B {
				continue
			}
			id := str(s, "id")
			if contains(k.SupportiveSkillTargets, str(s, "target")) {
				supportive = append(supportive, id)
			} else {
				offensive = append(offensive, id)
			}
		}
	}
	form := func(skillNode jv.Value, targets []string) jv.Value {
		p := jv.Obj("skill", skillNode)
		if len(targets) > 0 {
			p.Set("target", jv.Obj("type", jv.Str("string"), "enum", jv.StrArr(targets)))
		}
		return jv.Obj("type", jv.Str("object"), "properties", p, "required", jv.StrArr([]string{"skill"}), "additionalProperties", jv.BoolV(false))
	}
	if !known {
		// Skill kinds unknown: every skill counts as offensive.
		return form(skill, monsters), true
	}
	var forms []jv.Value
	if len(offensive) > 0 {
		forms = append(forms, form(jv.Obj("type", jv.Str("string"), "enum", jv.StrArr(offensive)), monsters))
	}
	if len(supportive) > 0 {
		var allies []string
		as, _ := jvRoom(obs).Get("agents")
		for _, a := range as.A {
			if n := str(a, "name"); n != "" && !contains(allies, n) {
				allies = append(allies, n)
			}
		}
		if self != "" && !contains(allies, self) {
			allies = append(allies, self)
		}
		forms = append(forms, form(jv.Obj("type", jv.Str("string"), "enum", jv.StrArr(supportive)), allies))
	}
	switch len(forms) {
	case 0:
		return jv.Value{}, false
	case 1:
		return forms[0], true
	}
	return jv.Obj("anyOf", jv.Value{Kind: jv.Array, A: forms}), true
}

// decisionSchema is {"type":"object","anyOf":[one closed object per action]}; each branch has the properties
// thought, action (a const), params, note, all required.
func (k *Kit) decisionSchema(actions []MenuAction) jv.Value {
	branches := make([]jv.Value, 0, len(actions))
	for _, a := range actions {
		branches = append(branches, jv.Obj(
			"type", jv.Str("object"),
			"properties", jv.Obj(
				"thought", jv.Obj("type", jv.Str("string"), "maxLength", jv.Int(k.Decision.ThoughtMax)),
				"action", jv.Obj("const", jv.Str(a.Name)),
				"params", a.Params,
				"note", jv.Obj("type", jv.Str("string"), "maxLength", jv.Int(k.Decision.NoteMax)),
			),
			"required", jv.StrArr([]string{"thought", "action", "params", "note"}),
			"additionalProperties", jv.BoolV(false),
		))
	}
	return jv.Obj("type", jv.Str("object"), "anyOf", jv.Value{Kind: jv.Array, A: branches})
}

// agentFields are params that take another agent's name (as in packages/shared/src/signature.ts).
var agentFields = map[string]bool{"agent": true, "to": true, "candidate": true}

// Signature writes an action's params on one line, by the same rules as the server's signature.ts, from the
// narrowed schema: `move {"dir": "north|south"}`, `cast {"skill": "firebolt", "target"?: "<target>"}`.
func Signature(action string, params jv.Value) string {
	return action + " " + shape(params, "params")
}

func shape(node jv.Value, field string) string {
	if node.Kind != jv.Object {
		return "<" + field + ">"
	}
	if any, ok := node.Get("anyOf"); ok && any.Kind == jv.Array {
		var variants, nonNull []jv.Value
		for _, v := range any.A {
			if v.Kind == jv.Object {
				variants = append(variants, v)
				if t, _ := v.Get("type"); t.Text() != "null" {
					nonNull = append(nonNull, v)
				}
			}
		}
		first := "<" + field + ">"
		if len(nonNull) > 0 {
			first = shape(nonNull[0], field)
		}
		if len(nonNull) < len(variants) {
			return first + "|null"
		}
		return first
	}
	if enum, ok := node.Get("enum"); ok && enum.Kind == jv.Array {
		parts := make([]string, len(enum.A))
		for i, e := range enum.A {
			if e.Kind == jv.String {
				parts[i] = e.S
			} else {
				parts[i] = jv.Canon(e)
			}
		}
		return `"` + strings.Join(parts, "|") + `"`
	}
	t, _ := node.Get("type")
	switch t.Text() {
	case "string":
		if p, _ := node.Get("pattern"); strings.Contains(p.Text(), "[0-9a-fA-F]{6}") {
			return `"#rrggbb"`
		}
		if agentFields[field] {
			return `"<name>"`
		}
		return `"<` + field + `>"`
	case "integer", "number":
		return "<" + field + ">"
	case "array":
		if pre, ok := node.Get("prefixItems"); ok && pre.Kind == jv.Array {
			parts := make([]string, len(pre.A))
			for i, x := range pre.A {
				parts[i] = shape(x, field)
			}
			return "[" + strings.Join(parts, ", ") + "]"
		}
		items, _ := node.Get("items")
		return "[" + shape(items, field) + "]"
	case "object":
		props, hasProps := node.Get("properties")
		if addl, ok := node.Get("additionalProperties"); (!hasProps || props.Kind != jv.Object) && ok && addl.Kind == jv.Object {
			return `{"<item>": ` + shape(addl, "qty") + "}"
		}
		required, _ := node.Get("required")
		req := map[string]bool{}
		for _, r := range required.A {
			req[r.Text()] = true
		}
		fields := make([]string, 0, len(props.O))
		for _, m := range props.O {
			opt := "?"
			if req[m.Key] {
				opt = ""
			}
			fields = append(fields, `"`+m.Key+`"`+opt+": "+shape(m.Val, m.Key))
		}
		return "{" + strings.Join(fields, ", ") + "}"
	}
	return "<" + field + ">"
}
