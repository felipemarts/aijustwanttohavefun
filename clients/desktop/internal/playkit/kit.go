// Package playkit is the Go implementation of clients/playkit: how a character thinks, as data plus a written
// algorithm (clients/playkit/README.md). Everything here is deterministic: the same inputs give byte-identical
// prompts and schemas in this core and in the TypeScript one, which the golden vectors in clients/playkit/vectors
// check.
package playkit

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
)

// The kit files are copied from clients/playkit by `go generate` (Go cannot embed files outside its module);
// TestKitInSync fails when the copy and the source differ.
//
//go:generate go run ./sync
//go:embed kit/playkit.json kit/prompts/*.txt kit/bench/situations.json kit/vectors/schema.json kit/vectors/map.json
var kitFS embed.FS

// BenchFiles returns the embedded situation bench, its schema document and its map (README 11).
func BenchFiles() (situations, schema, worldMap []byte, err error) {
	if situations, err = kitFS.ReadFile("kit/bench/situations.json"); err != nil {
		return
	}
	if schema, err = kitFS.ReadFile("kit/vectors/schema.json"); err != nil {
		return
	}
	worldMap, err = kitFS.ReadFile("kit/vectors/map.json")
	return
}

// Config mirrors playkit.json.
type Config struct {
	Version  string `json:"version"`
	Decision struct {
		ThoughtMax    int      `json:"thoughtMax"`
		NoteMax       int      `json:"noteMax"`
		TextMax       int      `json:"textMax"`
		RawMax        int      `json:"rawMax"`
		ForbiddenKeys []string `json:"forbiddenKeys"`
		ForbiddenText []string `json:"forbiddenText"`
	} `json:"decision"`
	ExcludedActions []string `json:"excludedActions"`
	// AlwaysOffered: actions that are always legal but that the game's `actions` list leaves out.
	AlwaysOffered []string `json:"alwaysOffered"`
	// OmitParams: optional params removed from the menu (small models invent values for them).
	OmitParams []struct {
		Action string `json:"action"`
		Param  string `json:"param"`
	} `json:"omitParams"`
	PvpActions      []string `json:"pvpActions"`
	// SupportiveSkillTargets: skill targets (from GET /me skills[].target) that make a skill supportive.
	SupportiveSkillTargets []string `json:"supportiveSkillTargets"`
	WakeOnName             []string `json:"wakeOnName"`
	Narrow          []struct {
		Action  string `json:"action"`
		Param   string `json:"param"`
		From    string `json:"from"`
		PvpFrom string `json:"pvpFrom"`
	} `json:"narrow"`
	FallbackActions []string          `json:"fallbackActions"`
	StepHints       map[string]string `json:"stepHints"`
	Limits          map[string]int `json:"limits"`
	RefreshMeAfter  []string       `json:"refreshMeAfter"`
	WakeKinds       []string       `json:"wakeKinds"`
	Pace            map[string]struct {
		SessionTurns int `json:"sessionTurns"`
		GapSeconds   int `json:"gapSeconds"`
		PollSeconds  int `json:"pollSeconds"`
	} `json:"pace"`
	AP struct {
		StopBelow    int `json:"stopBelow"`
		ResumeAt     int `json:"resumeAt"`
		RegenSeconds int `json:"regenSeconds"`
	} `json:"ap"`
	Requests struct {
		PerMinute            int `json:"perMinute"`
		TurnGapMs            int `json:"turnGapMs"`
		CooldownWaitSeconds  int `json:"cooldownWaitSeconds"`
		MaxRetryAfterSeconds int `json:"maxRetryAfterSeconds"`
	} `json:"requests"`
	Sampling struct {
		Temperature   float64 `json:"temperature"`
		TopK          int     `json:"topK"`
		RepeatPenalty float64 `json:"repeatPenalty"`
		MaxTokens     int     `json:"maxTokens"`
		ChatMaxTokens int     `json:"chatMaxTokens"`
	} `json:"sampling"`
	Languages map[string]string `json:"languages"`
	Planner   PlannerConfig     `json:"planner"`
	Stuck     StuckConfig       `json:"stuck"`
	Engine    struct {
		TimeoutBaseSeconds   int     `json:"timeoutBaseSeconds"`
		FloorTokensPerSecond float64 `json:"floorTokensPerSecond"`
		BackoffSeconds       int     `json:"backoffSeconds"`
	} `json:"engine"`
	Speech    SpeechConfig      `json:"speech"`
}

// Kit is the loaded configuration and templates.
type Kit struct {
	Config
	Templates map[string]string
}

// Lim returns a limit from playkit.json; a missing one is a programming error.
func (k *Kit) Lim(name string) int {
	v, ok := k.Limits[name]
	if !ok {
		panic("playkit: unknown limit " + name)
	}
	return v
}

// Load reads the embedded kit.
func Load() (*Kit, error) {
	raw, err := kitFS.ReadFile("kit/playkit.json")
	if err != nil {
		return nil, err
	}
	k := &Kit{Templates: map[string]string{}}
	if err := json.Unmarshal(raw, &k.Config); err != nil {
		return nil, fmt.Errorf("playkit.json: %w", err)
	}
	if g, ok := k.Limits["monsterLevelGap"]; ok {
		fairGap = g
	}
	for _, name := range []string{"system", "turn", "retry", "chat", "compact"} {
		b, err := kitFS.ReadFile("kit/prompts/" + name + ".txt")
		if err != nil {
			return nil, err
		}
		k.Templates[name] = strings.ReplaceAll(string(b), "\r\n", "\n")
	}
	return k, nil
}

// MustLoad is Load for program start-up.
func MustLoad() *Kit {
	k, err := Load()
	if err != nil {
		panic(err)
	}
	return k
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// LanguageName names a BCP-47 tag for the prompt: the table entry for the exact tag, else for its primary subtag,
// else the tag itself.
func (k *Kit) LanguageName(tag string) string {
	if n, ok := k.Languages[tag]; ok {
		return n
	}
	primary, _, _ := strings.Cut(tag, "-")
	if n, ok := k.Languages[primary]; ok {
		return n
	}
	return tag
}

// IsWakeKind reports whether an event kind should wake a resting character.
func (k *Kit) IsWakeKind(kind string) bool { return contains(k.WakeKinds, kind) }

// Wakes reports whether one event (an item of GET /events) should wake a resting character: its kind is in
// wakeKinds, or its kind is in wakeOnName and its untrusted_text contains the character's name (compared after
// lower-casing both).
func (k *Kit) Wakes(event jv.Value, name string) bool {
	kind := str(event, "kind")
	if contains(k.WakeKinds, kind) {
		return true
	}
	if contains(k.WakeOnName, kind) && name != "" {
		return strings.Contains(strings.ToLower(str(event, "untrusted_text")), strings.ToLower(name))
	}
	return false
}

// RefreshesMe reports whether a successful action changes what GET /me shows.
func (k *Kit) RefreshesMe(action string) bool { return contains(k.RefreshMeAfter, action) }
