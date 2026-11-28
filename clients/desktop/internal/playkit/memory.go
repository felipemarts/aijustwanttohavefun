package playkit

import (
	"strings"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// Heard splits the `messages` of a game response: lines written by other agents (they carry `untrusted_text`) go to
// the chat buffer, the rest are game events (their `text`). Messages with neither are skipped.
func Heard(messages jv.Value) (chat []ChatLine, events []string) {
	for _, m := range messages.A {
		kind := str(m, "kind")
		if u, ok := m.Get("untrusted_text"); ok {
			chat = append(chat, ChatLine{From: str(m, "from"), Kind: kind, Text: u.Text()})
			continue
		}
		if t := str(m, "text"); t != "" {
			events = append(events, t)
		}
	}
	return chat, events
}

// Remember updates memory after a turn (README, "Memory"): the action joins `recent` (the last `recent` kept), the
// chat lines join the chat buffer (the last `chat` kept), and a non-empty note not already there joins `notes` when
// noteWait is 0 (it then becomes noteEvery; each turn with an action lowers it by one). It returns true when the
// notes now exceed `notes` and need compaction.
func (k *Kit) Remember(m *Memory, r *Recent, note string, chat []ChatLine) bool {
	if r != nil && r.OK && r.Action == "quest_accept" {
		if id := str(r.Params, "quest"); id != "" {
			var kept []QuestTold
			for _, t := range m.Told {
				if t.Quest != id {
					kept = append(kept, t)
				}
			}
			kept = append(kept, QuestTold{Quest: id, Text: Plain(r.Text, k.Lim("questText"))})
			if n := k.Lim("questsTold"); len(kept) > n {
				kept = kept[len(kept)-n:]
			}
			m.Told = kept
		}
	}
	if r != nil {
		rr := *r
		rr.Text = Plain(rr.Text, k.Lim("recentText"))
		m.Recent = append(m.Recent, rr)
		if n := k.Lim("recent"); len(m.Recent) > n {
			m.Recent = append([]Recent(nil), m.Recent[len(m.Recent)-n:]...)
		}
	}
	m.Chat = append(m.Chat, chat...)
	if n := k.Lim("chat"); len(m.Chat) > n {
		m.Chat = append([]ChatLine(nil), m.Chat[len(m.Chat)-n:]...)
	}
	if r != nil && m.NoteWait > 0 {
		m.NoteWait--
	} else if n := Plain(note, k.Decision.NoteMax); n != "" && !contains(m.Notes, n) {
		m.Notes = append(m.Notes, n)
		m.NoteWait = k.Lim("noteEvery")
	}
	return len(m.Notes) > k.Lim("notes")
}

// RecentOf makes the `recent` entry of an action's outcome: the narration when it went through, else
// "<code>: <message>".
func RecentOf(action string, params jv.Value, ok bool, narration string, e *GameErr) Recent {
	text := narration
	if !ok && e != nil {
		text = e.Code + ": " + e.Message
	}
	if params.Kind != jv.Object {
		params = jv.Obj()
	}
	return Recent{Action: action, Params: params, OK: ok, Text: text}
}

// CompactionTurn builds the messages and schema that merge notes into at most notesAfterCompaction.
func (k *Kit) CompactionTurn(name string, notes []string) ([]Message, jv.Value) {
	lines := make([]string, len(notes))
	for i, n := range notes {
		lines[i] = "- " + Plain(n, k.Decision.NoteMax)
	}
	max := k.Lim("notesAfterCompaction")
	prompt := Render(k.Templates["compact"], map[string]string{
		"name":  Plain(name, k.Lim("nameText")),
		"max":   jv.FormatNumber(float64(max)),
		"len":   jv.FormatNumber(float64(k.Decision.NoteMax)),
		"notes": strings.Join(lines, "\n"),
	})
	schema := jv.Obj("type", jv.Str("object"),
		"properties", jv.Obj("notes", jv.Obj("type", jv.Str("array"),
			"items", jv.Obj("type", jv.Str("string"), "maxLength", jv.Int(k.Decision.NoteMax)),
			"maxItems", jv.Int(max))),
		"required", jv.StrArr([]string{"notes"}),
		"additionalProperties", jv.BoolV(false))
	return []Message{{Role: "user", Content: prompt}}, schema
}

// ApplyCompaction reads the compaction answer. On any problem the notes are cut to the newest `notes` instead.
func (k *Kit) ApplyCompaction(raw string, notes []string) []string {
	cut := func() []string {
		if n := k.Lim("notes"); len(notes) > n {
			return append([]string(nil), notes[len(notes)-n:]...)
		}
		return notes
	}
	v, problem := k.Extract(raw)
	if problem != "" {
		return cut()
	}
	_, schema := k.CompactionTurn("", nil)
	if validate(v, schema, "answer") != "" {
		return cut()
	}
	list, _ := v.Get("notes")
	var out []string
	for _, x := range list.A {
		if n := Plain(x.S, k.Decision.NoteMax); n != "" && !contains(out, n) {
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		return cut()
	}
	return out
}

// ChatInput is what a chat reply to the owner is made of.
type ChatInput struct {
	Character   Character `json:"character"`
	Observation jv.Value  `json:"observation"`
	Me          jv.Value  `json:"me"`
	Memory      Memory    `json:"memory"`
	// History: earlier messages of this conversation, oldest first; from is "owner" or "character".
	History []struct {
		From string `json:"from"`
		Text string `json:"text"`
	} `json:"history"`
	Text string `json:"text"`
}

// ChatTurn builds the messages of a reply to the owner. The reply is free text and never an action.
func (k *Kit) ChatTurn(in ChatInput) []Message {
	wish := Plain(in.Character.Wish, k.Lim("wishText"))
	if wish == "" {
		wish = "none; play as you like."
	}
	persona := Plain(in.Character.Persona, k.Lim("personaText"))
	if persona == "" {
		persona = "an adventurer new to Mistvale."
	}
	status := k.statusBlock(in.Character, in.Observation, in.Me)
	if room, ok := in.Observation.Get("room"); ok {
		status += "\nPlace: " + Plain(str(room, "name"), 80) + " (" + str(room, "id") + ")."
	}
	sys := Render(k.Templates["chat"], map[string]string{
		"name":    Plain(in.Character.Name, k.Lim("nameText")),
		"level":   level(in.Observation),
		"class":   in.Character.Class,
		"persona": persona,
		"wish":    wish,
		"status":  status,
		"notes":   k.NotesBlock(in.Memory.Notes),
		"recent":  k.RecentBlock(in.Memory.Recent),
		"chat":    k.ChatBlock(in.Memory.Chat),
	})
	msgs := []Message{{Role: "system", Content: sys}}
	hist := in.History
	if n := k.Lim("chatHistory"); len(hist) > n {
		hist = hist[len(hist)-n:]
	}
	for _, h := range hist {
		role := "user"
		if h.From == "character" {
			role = "assistant"
		}
		msgs = append(msgs, Message{Role: role, Content: Clip(TrimSpace(h.Text), k.Lim("ownerText"))})
	}
	msgs = append(msgs, Message{Role: "user", Content: Clip(TrimSpace(in.Text), k.Lim("ownerText"))})
	return msgs
}
