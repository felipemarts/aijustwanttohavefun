// Command ajwf-player puts your agents in AI Just Want to Have Fun, played by a local AI.
//
// Run without a subcommand to start the core, serve the interface on 127.0.0.1 and open it in the browser.
// Subcommands play and manage characters without the interface; see `ajwf-player help`.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/bench"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/core"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/engine"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/httpapi"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/lock"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/paths"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/store"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/webui"
)

const usage = `ajwf-player: your agents in AI Just Want to Have Fun, played by a local AI.

Usage:
  ajwf-player [flags]                 start, serve the interface on 127.0.0.1 and open the browser
      --no-open                       do not open the browser (the URL with its session token is printed)
      --port N                        port of the interface (default: a free one)

  ajwf-player open                    print and open the interface link of the running program again
  ajwf-player create --name N --class warrior|mage|rogue|cleric [--language en] [--persona "..."] [--bio "..."]
                     [--wish "..."] [--pace relaxed|normal|active] [--pvp] [--paused]
  ajwf-player run [--turns N [--count-for NAME]] [--character NAME] [--trace]
                                      play headless (all characters set to run, or the one named) until
                                      Ctrl+C or N turns
  ajwf-player status                  characters and the engine
  ajwf-player log NAME [-n 30]        the character's activity log, newest last
  ajwf-player control NAME on|off     set whether it plays
  ajwf-player directives NAME [--persona ...] [--wish ...] [--pace ...] [--pvp=true|false]
  ajwf-player command NAME "text"     a wish for its next turns
  ajwf-player chat NAME "text"        talk with it (it answers, it does not act)
  ajwf-player claim NAME              print and open the claim link (a human must claim an agent before it speaks)
  ajwf-player forget NAME             remove it from this device (the agent stays in the world)
  ajwf-player engine show|download|test
  ajwf-player engine use builtin|ollama|lmstudio|openai [--url URL] [--model M] [--api-key-env VAR]
  ajwf-player settings [--server URL] [--language TAG]
  ajwf-player bench [--engine builtin|ollama|lmstudio|openai] [--url URL] [--model M] [--api-key-env VAR]
                    [--only id,id] [--repeat N] [--playkit DIR] [--json FILE]
                                      score the engine on the playkit's situation bench (no game server)

Flags for every command:
  --data-dir DIR    where characters, logs and settings live (default: the OS config directory)
  --cache-dir DIR   where the engine and model are downloaded (default: the OS cache directory)
  --server URL      game server for this run (default: the saved setting, else ` + core.DefaultServer + `)
  --secrets auto|keychain|file   where agent keys are kept (default auto: the OS keychain when it works)
`

type common struct {
	dataDir, cacheDir, server, secrets string
}

func (c *common) register(fs *flag.FlagSet) {
	fs.StringVar(&c.dataDir, "data-dir", "", "")
	fs.StringVar(&c.cacheDir, "cache-dir", "", "")
	fs.StringVar(&c.server, "server", "", "")
	fs.StringVar(&c.secrets, "secrets", "auto", "")
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "ajwf-player: "+format+"\n", a...)
	os.Exit(1)
}

// open builds the core; withLock takes the data-directory lock (any command that writes).
func (c *common) open(withLock bool, trace bool) (*core.Core, *lock.Lock) {
	data, err := paths.Data(c.dataDir)
	if err != nil {
		die("%v", err)
	}
	cache, err := paths.Cache(c.cacheDir)
	if err != nil {
		die("%v", err)
	}
	if err := os.MkdirAll(data, 0o700); err != nil {
		die("%v", err)
	}
	var l *lock.Lock
	if withLock {
		if l, err = lock.Acquire(data); err != nil {
			die("%v", err)
		}
	}
	co, err := core.New(core.Options{DataDir: data, CacheDir: cache, SecretsMode: c.secrets, Server: c.server, Trace: trace,
		Logf: func(s string) { fmt.Fprintln(os.Stderr, time.Now().Format("15:04:05"), s) }})
	if err != nil {
		l.Release()
		die("%v", err)
	}
	return co, l
}

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "", "serve":
		serve(args)
	case "open":
		openRunning(args)
	case "help", "-h", "--help":
		fmt.Print(usage)
	case "create":
		create(args)
	case "run":
		run(args)
	case "status":
		status(args)
	case "log":
		showLog(args)
	case "control":
		control(args)
	case "directives":
		directives(args)
	case "command", "chat":
		talk(cmd, args)
	case "claim":
		claim(args)
	case "forget":
		forget(args)
	case "engine":
		engineCmd(args)
	case "settings":
		settings(args)
	case "bench":
		benchCmd(args)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

// parse splits flags from positional arguments in any order.
func parse(fs *flag.FlagSet, args []string) []string {
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			os.Exit(2)
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func signals() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func serve(args []string) {
	var c common
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	c.register(fs)
	noOpen := fs.Bool("no-open", false, "")
	port := fs.Int("port", 0, "")
	trace := fs.Bool("trace", false, "")
	parse(fs, args)
	co, l := c.open(true, *trace)
	defer l.Release()
	srv, err := httpapi.Listen(co, webui.FS(), *port)
	if err != nil {
		die("%v", err)
	}
	co.Start()
	ctx, stop := signals()
	defer stop()
	go func() {
		if err := srv.Serve(); err != nil {
			die("%v", err)
		}
	}()
	// run.json (0600, in the 0700 data directory) lets `ajwf-player open` find this instance again.
	data, _ := paths.Data(c.dataDir)
	runFile := filepath.Join(data, "run.json")
	_ = store.WriteJSON(runFile, map[string]any{"port": srv.Port(), "token": srv.Token(), "pid": os.Getpid()})
	defer os.Remove(runFile)
	fmt.Println("ajwf-player is running. Interface (keep this link private, it carries the session token):")
	fmt.Println("  " + srv.URL())
	fmt.Println("Agent keys are kept in: " + co.SecretsKind() + ". Press Ctrl+C to stop.")
	if !*noOpen {
		if err := openBrowser(srv.URL()); err != nil {
			fmt.Println("Could not open the browser; open the link above.")
		}
	}
	<-ctx.Done()
	fmt.Println("Stopping…")
	sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = srv.Shutdown(sctx)
	cancel()
	co.Close()
}

// openRunning prints and opens the interface link of a running instance (when its tab was closed).
func openRunning(args []string) {
	var c common
	fs := flag.NewFlagSet("open", flag.ExitOnError)
	c.register(fs)
	parse(fs, args)
	data, err := paths.Data(c.dataDir)
	if err != nil {
		die("%v", err)
	}
	var run struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if err := store.ReadJSON(filepath.Join(data, "run.json"), &run); err != nil || run.Port == 0 {
		die("no running ajwf-player found for this data directory; start it with `ajwf-player`")
	}
	base := "http://127.0.0.1:" + strconv.Itoa(run.Port)
	req, _ := http.NewRequest(http.MethodGet, base+"/core/state", nil)
	req.Header.Set("Authorization", "Bearer "+run.Token)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil || resp.StatusCode != 200 {
		die("the recorded instance does not answer; start it with `ajwf-player`")
	}
	resp.Body.Close()
	u := base + "/#token=" + run.Token
	fmt.Println("  " + u)
	if err := openBrowser(u); err != nil {
		fmt.Println("Could not open the browser; open the link above.")
	}
}

// openBrowser opens a URL with the OS's default handler. The URL is passed as one argument, never through a shell.
func openBrowser(u string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	return cmd.Start()
}

func create(args []string) {
	var c common
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	c.register(fs)
	name := fs.String("name", "", "")
	class := fs.String("class", "", "")
	lang := fs.String("language", "en", "")
	persona := fs.String("persona", "", "")
	bio := fs.String("bio", "", "")
	wish := fs.String("wish", "", "")
	pace := fs.String("pace", "normal", "")
	pvp := fs.Bool("pvp", false, "")
	paused := fs.Bool("paused", false, "")
	_ = fs.Bool("run", true, "") // kept for old scripts: characters are created running
	parse(fs, args)
	co, l := c.open(true, false)
	defer l.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sum, err := co.CreateCharacter(ctx, core.NewCharacter{Name: *name, Class: *class, Language: *lang, Persona: *persona, Bio: *bio, Wish: *wish, Pace: *pace, AllowPvp: *pvp, Appearance: "surprise_me"})
	if err != nil {
		die("%v", err)
	}
	if *paused {
		if _, err := co.Control(sum.ID, false); err != nil {
			die("%v", err)
		}
	}
	fmt.Printf("Created %s (%s), local id %s.\n", sum.Name, sum.Class, sum.ID)
	if sum.ClaimPending {
		fmt.Println("Before it can speak, a human must claim it: `ajwf-player claim " + sum.Name + "` opens the link.")
	}
	co.Close()
}

func find(co *core.Core, name string) string {
	id, ok := co.FindByName(name)
	if !ok {
		die("no character named %q", name)
	}
	return id
}

func run(args []string) {
	var c common
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	c.register(fs)
	turns := fs.Int("turns", 0, "")
	countFor := fs.String("count-for", "", "")
	only := fs.String("character", "", "")
	trace := fs.Bool("trace", false, "")
	parse(fs, args)
	co, l := c.open(true, *trace)
	defer l.Release()
	if *only != "" {
		id := find(co, *only)
		for _, s := range co.State().Characters {
			if _, err := co.Control(s.ID, s.ID == id); err != nil {
				die("%v", err)
			}
		}
	}
	events, unsub := co.Subscribe()
	defer unsub()
	done := co.SetTurnLimit(*turns, *countFor)
	if *turns == 0 {
		done = nil
	}
	co.Start()
	if pid := co.EnginePID(); pid > 0 {
		fmt.Println("llama-server pid", pid)
	}
	ctx, stop := signals()
	defer stop()
	names := map[string]string{}
	for _, s := range co.State().Characters {
		names[s.ID] = s.Name
	}
	for {
		select {
		case <-ctx.Done():
			co.Close()
			return
		case <-done:
			time.Sleep(500 * time.Millisecond)
			co.Close()
			fmt.Println("Turn limit reached.")
			return
		case ev := <-events:
			switch ev.Type {
			case "log":
				e := ev.Entry
				line := e.Text
				if e.Quote != nil {
					line = e.Quote.From + ": " + fmt.Sprintf("%q", e.Quote.Text)
				}
				if e.Action != "" {
					line = "[" + e.Action + "] " + line
				}
				fmt.Printf("%s %-10s %-7s %s\n", time.UnixMilli(e.TS).Format("15:04:05"), names[ev.ID], e.Kind, line)
			case "engine":
				if ev.Engine.Message != "" {
					fmt.Println("engine:", ev.Engine.Status, ev.Engine.Message)
				}
			case "character":
				names[ev.Character.ID] = ev.Character.Name
				if ev.Character.Problem != "" {
					fmt.Println(ev.Character.Name+":", ev.Character.Problem)
				}
			}
		}
	}
}

func status(args []string) {
	var c common
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	c.register(fs)
	asJSON := fs.Bool("json", false, "")
	parse(fs, args)
	co, _ := c.open(false, false)
	st := co.State()
	if *asJSON {
		b, _ := json.MarshalIndent(st, "", "  ")
		fmt.Println(string(b))
		return
	}
	e := st.Engine
	fmt.Printf("Engine: %s, %s", e.Choice.Kind, e.Status)
	if e.Builtin != nil {
		fmt.Printf(" (%s, %s)", e.Builtin.Model, e.Builtin.LicenseName)
	}
	if e.Message != "" {
		fmt.Printf(": %s", e.Message)
	}
	fmt.Printf("\nGame server: %s\nKeys kept in: %s\n\n", st.Settings.ServerURL, co.SecretsKind())
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tCLASS\tLVL\tHP\tAP\tGOLD\tWHERE\tSTATUS\tCLAIMED")
	for _, ch := range st.Characters {
		fmt.Fprintf(tw, "%s\t%s\t%d\t%.0f/%.0f\t%.0f/%.0f\t%d\t%s\t%s\t%v\n", ch.Name, ch.Class, ch.Level, ch.HP[0], ch.HP[1], ch.AP[0], ch.AP[1], ch.Gold, ch.Room.Name, ch.Status, ch.Claimed)
	}
	tw.Flush()
}

func showLog(args []string) {
	var c common
	fs := flag.NewFlagSet("log", flag.ExitOnError)
	c.register(fs)
	n := fs.Int("n", 30, "")
	pos := parse(fs, args)
	if len(pos) != 1 {
		die("usage: log NAME [-n 30]")
	}
	co, _ := c.open(false, false)
	entries, err := co.Log(find(co, pos[0]), "", *n)
	if err != nil {
		die("%v", err)
	}
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		line := e.Text
		if e.Quote != nil {
			line = e.Quote.From + ": " + fmt.Sprintf("%q", e.Quote.Text)
		}
		if e.Action != "" {
			line = "[" + e.Action + "] " + line
			if e.Thought != "" {
				line += "  (thought: " + e.Thought + ")"
			}
		}
		fmt.Printf("%s %-7s %s\n", time.UnixMilli(e.TS).Format("01-02 15:04:05"), e.Kind, line)
	}
}

func control(args []string) {
	var c common
	fs := flag.NewFlagSet("control", flag.ExitOnError)
	c.register(fs)
	pos := parse(fs, args)
	if len(pos) != 2 || (pos[1] != "on" && pos[1] != "off") {
		die("usage: control NAME on|off")
	}
	co, l := c.open(true, false)
	defer l.Release()
	if _, err := co.Control(find(co, pos[0]), pos[1] == "on"); err != nil {
		die("%v", err)
	}
	co.Close()
}

func directives(args []string) {
	var c common
	fs := flag.NewFlagSet("directives", flag.ExitOnError)
	c.register(fs)
	persona := fs.String("persona", "\x00", "")
	wish := fs.String("wish", "\x00", "")
	pace := fs.String("pace", "", "")
	pvp := fs.String("pvp", "", "")
	pos := parse(fs, args)
	if len(pos) != 1 {
		die("usage: directives NAME [--persona ...] [--wish ...] [--pace ...] [--pvp=true|false]")
	}
	co, l := c.open(true, false)
	defer l.Release()
	id := find(co, pos[0])
	d, err := co.Character(id)
	if err != nil {
		die("%v", err)
	}
	dir := d.Directives
	if *persona != "\x00" {
		dir.Persona = *persona
	}
	if *wish != "\x00" {
		dir.Wish = *wish
	}
	if *pace != "" {
		dir.Pace = *pace
	}
	if *pvp != "" {
		dir.AllowPvp = *pvp == "true"
	}
	out, err := co.SetDirectives(id, dir)
	if err != nil {
		die("%v", err)
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	co.Close()
}

func talk(cmd string, args []string) {
	var c common
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	c.register(fs)
	pos := parse(fs, args)
	if len(pos) < 2 {
		die("usage: %s NAME \"text\"", cmd)
	}
	co, l := c.open(true, false)
	defer l.Release()
	id := find(co, pos[0])
	text := strings.Join(pos[1:], " ")
	if cmd == "command" {
		if err := co.Command(id, text); err != nil {
			die("%v", err)
		}
		fmt.Println("Queued for its next turns.")
		co.Close()
		return
	}
	ctx, stop := signals()
	defer stop()
	if err := co.WaitEngine(ctx); err != nil {
		die("engine: %v", err)
	}
	m, err := co.Chat(ctx, id, text)
	if err != nil {
		die("%v", err)
	}
	fmt.Println(m.Text)
	co.Close()
}

func claim(args []string) {
	var c common
	fs := flag.NewFlagSet("claim", flag.ExitOnError)
	c.register(fs)
	pos := parse(fs, args)
	if len(pos) != 1 {
		die("usage: claim NAME")
	}
	co, _ := c.open(false, false)
	u, err := co.ClaimLink(find(co, pos[0]))
	if err != nil {
		die("%v", err)
	}
	if u == "" {
		fmt.Println("Already claimed (or the link was used).")
		return
	}
	fmt.Println("Open this link in your browser, logged in to the game site, to claim " + pos[0] + ". Give it to nobody else:")
	fmt.Println("  " + u)
	_ = openBrowser(u)
}

func forget(args []string) {
	var c common
	fs := flag.NewFlagSet("forget", flag.ExitOnError)
	c.register(fs)
	pos := parse(fs, args)
	if len(pos) != 1 {
		die("usage: forget NAME")
	}
	co, l := c.open(true, false)
	defer l.Release()
	if err := co.Forget(find(co, pos[0])); err != nil {
		die("%v", err)
	}
	fmt.Println("Forgotten on this device.")
	co.Close()
}

func engineCmd(args []string) {
	if len(args) == 0 {
		die("usage: engine show|download|test|use KIND")
	}
	sub, rest := args[0], args[1:]
	var c common
	fs := flag.NewFlagSet("engine", flag.ExitOnError)
	c.register(fs)
	url := fs.String("url", "", "")
	model := fs.String("model", "", "")
	keyEnv := fs.String("api-key-env", "", "")
	pos := parse(fs, rest)
	switch sub {
	case "show":
		co, _ := c.open(false, false)
		b, _ := json.MarshalIndent(map[string]any{"engine": co.EngineState(), "providers": co.Providers(context.Background())}, "", "  ")
		fmt.Println(string(b))
	case "download":
		co, l := c.open(true, false)
		defer l.Release()
		ctx, stop := signals()
		defer stop()
		err := co.DownloadAndWait(ctx, func(done, total int64) { fmt.Printf("%d/%d MB\n", done>>20, total>>20) })
		if err != nil {
			die("%v", err)
		}
		fmt.Println("Downloaded and verified.")
	case "test":
		co, l := c.open(true, false)
		defer l.Release()
		ctx, stop := signals()
		defer stop()
		if err := co.WaitEngine(ctx); err != nil {
			co.Close()
			die("engine: %v", err)
		}
		t := co.TestEngine(ctx)
		b, _ := json.MarshalIndent(t, "", "  ")
		fmt.Println(string(b))
		co.Close()
	case "use":
		if len(pos) != 1 {
			die("usage: engine use builtin|ollama|lmstudio|openai [--url URL] [--model M] [--api-key-env VAR]")
		}
		key := ""
		if *keyEnv != "" {
			key = os.Getenv(*keyEnv)
			if key == "" {
				die("environment variable %s is empty", *keyEnv)
			}
		}
		co, l := c.open(true, false)
		defer l.Release()
		st, err := co.SetEngine(core.EngineChoice{Kind: pos[0], URL: *url, Model: *model, APIKey: key})
		if err != nil {
			var ce *core.Error
			if errors.As(err, &ce) {
				die("%s", ce.Message)
			}
			die("%v", err)
		}
		time.Sleep(300 * time.Millisecond)
		fmt.Printf("Engine: %s %s %s\n", st.Choice.Kind, st.Choice.URL, st.Choice.Model)
		co.Close()
	default:
		die("usage: engine show|download|test|use KIND")
	}
}

func benchCmd(args []string) {
	var c common
	fs := flag.NewFlagSet("bench", flag.ExitOnError)
	c.register(fs)
	kind := fs.String("engine", "builtin", "")
	url := fs.String("url", "", "")
	model := fs.String("model", "", "")
	keyEnv := fs.String("api-key-env", "", "")
	only := fs.String("only", "", "")
	repeat := fs.Int("repeat", 1, "")
	dir := fs.String("playkit", "", "")
	jsonOut := fs.String("json", "", "")
	parse(fs, args)
	k := playkit.MustLoad()
	var sit, sch, wm []byte
	var err error
	if *dir != "" {
		read := func(p string) []byte {
			b, err := os.ReadFile(filepath.Join(*dir, p))
			if err != nil {
				die("%v", err)
			}
			return b
		}
		sit, sch, wm = read("bench/situations.json"), read("vectors/schema.json"), read("vectors/map.json")
	} else if sit, sch, wm, err = playkit.BenchFiles(); err != nil {
		die("%v", err)
	}
	b, err := bench.Load(sit, sch, wm)
	if err != nil {
		die("%v", err)
	}
	ctx, stop := signals()
	defer stop()
	var p engine.Provider
	key := ""
	if *keyEnv != "" {
		key = os.Getenv(*keyEnv)
	}
	switch *kind {
	case "builtin":
		cache, err := paths.Cache(c.cacheDir)
		if err != nil {
			die("%v", err)
		}
		bi := &engine.Builtin{CacheDir: cache, Log: func(s string) { fmt.Fprintln(os.Stderr, s) }}
		defer bi.Stop()
		if p, err = bi.Start(ctx); err != nil {
			die("built-in engine: %v (download it with `ajwf-player engine download`)", err)
		}
		fmt.Printf("engine: built-in %s, llama-server pid %d\n", engine.ModelName, bi.PID())
	case "ollama", "lmstudio", "openai":
		u, err := engine.NormalizeURL(*url)
		if err != nil {
			die("--url: %v", err)
		}
		if *kind == "ollama" {
			p = &engine.Ollama{Base: u, Model: *model}
		} else {
			p = &engine.OpenAI{Base: u, Model: *model, APIKey: key, Extras: *kind == "lmstudio"}
		}
		fmt.Printf("engine: %s %s %s\n", *kind, u, *model)
	default:
		die("--engine must be builtin, ollama, lmstudio or openai")
	}
	o := bench.Options{Repeat: *repeat}
	if *only != "" {
		o.Only = strings.Split(*only, ",")
	}
	results, err := b.Run(ctx, k, p, o, os.Stdout)
	if *jsonOut != "" {
		data, _ := json.MarshalIndent(results, "", "  ")
		_ = os.WriteFile(*jsonOut, data, 0o600)
	}
	if err != nil {
		die("%v", err)
	}
}

func settings(args []string) {
	var c common
	fs := flag.NewFlagSet("settings", flag.ExitOnError)
	c.register(fs)
	lang := fs.String("language", "", "")
	parse(fs, args)
	server := c.server
	c.server = ""
	co, l := c.open(true, false)
	defer l.Release()
	patch := map[string]json.RawMessage{}
	if server != "" {
		b, _ := json.Marshal(server)
		patch["serverUrl"] = b
	}
	if *lang != "" {
		b, _ := json.Marshal(*lang)
		patch["language"] = b
	}
	st, err := co.SetSettings(patch)
	if err != nil {
		die("%v", err)
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	fmt.Println(string(b))
	co.Close()
}
