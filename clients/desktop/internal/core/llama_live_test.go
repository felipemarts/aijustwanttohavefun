package core

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// TestEveryActionSchemaAcceptedByLlamaServer sends, for every action of the schema fixture, a one-action menu to a
// running llama-server (LLAMA_URL, LLAMA_KEY), so an unsupported schema construct is found before a game finds it.
// Skipped unless LLAMA_URL is set.
func TestEveryActionSchemaAcceptedByLlamaServer(t *testing.T) {
	base := os.Getenv("LLAMA_URL")
	if base == "" {
		t.Skip("LLAMA_URL not set")
	}
	k := playkit.MustLoad()
	b, err := os.ReadFile("../../../playkit/vectors/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := playkit.ParseSchemaDoc(string(b))
	if err != nil {
		t.Fatal(err)
	}
	p := &engine.OpenAI{Base: base, APIKey: os.Getenv("LLAMA_KEY"), Extras: true, LlamaCpp: true}
	obs, _ := jv.Parse(`{"you":{"lvl":10},"room":{"id":"r","exits":{"north":"n"},"agents":[{"name":"Gorm"}],"monsters":[{"id":"wolf","n":1,"lvl":3}],"npcs":[{"id":"olga","roles":["shop","quest"]}],"resources":{"herb":2},"items":{"stone":1}},"pending":{"party":["Gorm"],"friends":["Gorm"],"guild":["G"],"duel":["Gorm"],"trades":[{"id":"t1"}]}}`)
	me, _ := jv.Parse(`{"inventory":{"bread":1},"equipment":{"weapon":"sword"},"skills":[{"id":"heal","target":"ally"},{"id":"smite","target":"enemy"}]}`)
	for _, a := range doc.Actions {
		o := obs.Clone()
		o.Set("actions", jv.StrArr([]string{a.Name}))
		menu := k.BuildMenu(doc, o, me, false, "Pip", nil)
		if len(menu.Actions) == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		_, err := p.Complete(ctx, engine.Request{Messages: []playkit.Message{{Role: "user", Content: "Choose."}}, Schema: &menu.Schema, MaxTokens: 1, Temperature: 0.1, TopK: 50, RepeatPenalty: 1.1})
		cancel()
		if err != nil {
			t.Errorf("%s: %v", a.Name, err)
		}
	}
}
