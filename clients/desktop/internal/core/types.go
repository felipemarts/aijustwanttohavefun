// Package core is the desktop core: it owns the characters, talks to the game server, runs the local AI and plays,
// and exposes all of it through the types of clients/playkit/core-api.ts.
package core

// The types below mirror clients/playkit/core-api.ts field for field. Keep them in step.

type Gauge [2]float64

type CharacterSummary struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Class        string       `json:"class"`
	Level        int          `json:"level"`
	XP           Gauge        `json:"xp"`
	HP           Gauge        `json:"hp"`
	MP           Gauge        `json:"mp"`
	AP           Gauge        `json:"ap"`
	Gold         int          `json:"gold"`
	Room         RoomRef      `json:"room"`
	Sprite       *string      `json:"sprite"`
	Title        *string      `json:"title"`
	Status       string       `json:"status"`
	Activity     string       `json:"activity"`
	NextActionAt int64        `json:"nextActionAt,omitempty"`
	Problem      string       `json:"problem,omitempty"`
	Claimed      bool         `json:"claimed"`
	ClaimPending bool         `json:"claimPending"`
	WatchURL     string       `json:"watchUrl"`
	Away         *AwaySummary `json:"away,omitempty"`
	Stuck        *Stuck       `json:"stuck,omitempty"`
}

// Stuck is set while the character makes no progress (reason: refusals, no_progress, lost).
type Stuck struct {
	Since  int64  `json:"since"`
	Reason string `json:"reason"`
}

type RoomRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type AwaySummary struct {
	Since      int64    `json:"since"`
	Actions    int      `json:"actions"`
	Levels     int      `json:"levels"`
	XP         int      `json:"xp"`
	Gold       int      `json:"gold"`
	Kills      int      `json:"kills"`
	Deaths     int      `json:"deaths"`
	Highlights []string `json:"highlights"`
}

// NamedRef is an id with its display name in the interface language.
type NamedRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ItemStack struct {
	ID   string    `json:"id"`
	Name string    `json:"name"`
	Qty  int       `json:"qty"`
	Slot *NamedRef `json:"slot,omitempty"`
}

type StatEntry struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

type QuestStep struct {
	Text string `json:"text"`
	Have int    `json:"have"`
	Need int    `json:"need"`
}

type QuestProgress struct {
	ID    string      `json:"id"`
	Name  string      `json:"name"`
	Steps []QuestStep `json:"steps"`
	Ready bool        `json:"ready"`
}

type PartyInfo struct {
	Members []string `json:"members"`
}

type CharacterDetail struct {
	CharacterSummary
	Bio          string             `json:"bio"`
	Stats        []StatEntry        `json:"stats"`
	Inventory    []ItemStack        `json:"inventory"`
	Quests       []QuestProgress    `json:"quests"`
	Achievements []string           `json:"achievements"`
	Party        *PartyInfo         `json:"party"`
	Guild        *string            `json:"guild"`
	Directives   Directives         `json:"directives"`
	Memory       []string           `json:"memory"`
}

type Directives struct {
	Persona  string `json:"persona"`
	Wish     string `json:"wish"`
	Pace     string `json:"pace"`
	AllowPvp bool   `json:"allowPvp"`
}

type AppearanceChoice struct {
	OptionsToken string            `json:"optionsToken"`
	Choice       map[string]string `json:"choice"`
}

type NewCharacter struct {
	Name     string `json:"name"`
	Class    string `json:"class"`
	Language string `json:"language"`
	Persona  string `json:"persona"`
	// Bio: the public bio the game shows (up to 300 characters). The persona is never sent to the game.
	Bio string `json:"bio,omitempty"`
	// "surprise_me" or an AppearanceChoice (decoded by the HTTP layer).
	Appearance any `json:"appearance"`
	// Optional extensions (see core-api.ts): the first wish, pace and PvP choice.
	Wish     string `json:"wish,omitempty"`
	Pace     string `json:"pace,omitempty"`
	AllowPvp bool   `json:"allowPvp,omitempty"`
}

type AppearanceOptions struct {
	OptionsToken string                       `json:"optionsToken"`
	ExpiresIn    int                          `json:"expiresIn"`
	Options      map[string]map[string]string `json:"options"`
}

type LogDelta struct {
	XP    *int `json:"xp,omitempty"`
	Gold  *int `json:"gold,omitempty"`
	HP    *int `json:"hp,omitempty"`
	Level *int `json:"level,omitempty"`
}

type Quote struct {
	From string `json:"from"`
	Text string `json:"text"`
}

type LogEntry struct {
	ID      string    `json:"id"`
	TS      int64     `json:"ts"`
	Kind    string    `json:"kind"`
	Text    string    `json:"text"`
	Action  string    `json:"action,omitempty"`
	Thought string    `json:"thought,omitempty"`
	Quote   *Quote    `json:"quote,omitempty"`
	Delta   *LogDelta `json:"delta,omitempty"`
	Big     bool      `json:"big,omitempty"`
}

type ChatMessage struct {
	ID   string `json:"id"`
	TS   int64  `json:"ts"`
	From string `json:"from"`
	Text string `json:"text"`
}

type EngineChoice struct {
	Kind   string `json:"kind"`
	URL    string `json:"url,omitempty"`
	Model  string `json:"model,omitempty"`
	APIKey string `json:"apiKey,omitempty"`
}

type EngineChoiceView struct {
	Kind      string `json:"kind"`
	URL       string `json:"url,omitempty"`
	Model     string `json:"model,omitempty"`
	HasAPIKey bool   `json:"hasApiKey,omitempty"`
}

type ProviderInfo struct {
	Kind      string   `json:"kind"`
	Label     string   `json:"label"`
	URL       string   `json:"url,omitempty"`
	Reachable bool     `json:"reachable"`
	Models    []string `json:"models"`
}

type BuiltinInfo struct {
	Model       string `json:"model"`
	File        string `json:"file"`
	LicenseName string `json:"licenseName"`
	LicenseURL  string `json:"licenseUrl"`
	BytesTotal  int64  `json:"bytesTotal"`
	BytesDone   int64  `json:"bytesDone"`
}

type EngineState struct {
	Choice          EngineChoiceView `json:"choice"`
	Status          string           `json:"status"`
	Builtin         *BuiltinInfo     `json:"builtin,omitempty"`
	Message         string           `json:"message,omitempty"`
	TokensPerSecond float64          `json:"tokensPerSecond,omitempty"`
}

type EngineTest struct {
	OK              bool    `json:"ok"`
	TokensPerSecond float64 `json:"tokensPerSecond"`
	ValidJSON       bool    `json:"validJson"`
	Sample          string  `json:"sample"`
	Message         string  `json:"message,omitempty"`
}

type Settings struct {
	ServerURL string `json:"serverUrl"`
	Language  string `json:"language"`
	KeepAwake *bool  `json:"keepAwake,omitempty"`
}

type ServerState struct {
	Reachable    bool   `json:"reachable"`
	SkillVersion string `json:"skillVersion,omitempty"`
}

type CoreState struct {
	Version    string             `json:"version"`
	Playkit    string             `json:"playkit"`
	Platform   string             `json:"platform"`
	Settings   Settings           `json:"settings"`
	Engine     EngineState        `json:"engine"`
	Characters []CharacterSummary `json:"characters"`
	Server     ServerState        `json:"server"`
}

// CoreEvent is one of the variants of core-api.ts's CoreEvent union.
type CoreEvent struct {
	Type      string            `json:"type"`
	Character *CharacterSummary `json:"character,omitempty"`
	ID        string            `json:"id,omitempty"`
	Entry     *LogEntry         `json:"entry,omitempty"`
	Engine    *EngineState      `json:"engine,omitempty"`
	MessageID string            `json:"messageId,omitempty"`
	Token     *string           `json:"token,omitempty"`
	Done      bool              `json:"done,omitempty"`
	Server    *ServerState      `json:"server,omitempty"`
}

// Error is a CoreError with an HTTP status.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errf(status int, code, msg string) *Error { return &Error{Status: status, Code: code, Message: msg} }
