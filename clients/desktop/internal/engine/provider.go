// Package engine talks to the local AI: the built-in llama-server it downloads and runs, or a server the user
// already has (Ollama, LM Studio, any OpenAI-compatible URL).
package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/jv"
	"github.com/aijustwanttohavefun/aijustwanttohavefun/clients/desktop/internal/playkit"
)

// Request is one completion.
type Request struct {
	Messages []playkit.Message
	// Schema, when set, asks for output constrained to it (or at least JSON, when the engine cannot constrain).
	Schema        *jv.Value
	MaxTokens     int
	Temperature   float64
	TopK          int
	RepeatPenalty float64
	// OnToken, when set, streams the answer.
	OnToken func(string)
}

// Result is the answer and how fast it came.
type Result struct {
	Text             string
	PromptTokens     int
	CompletionTokens int
	TokensPerSecond  float64
	Elapsed          time.Duration
	// Mode is how the output was constrained: "schema", "json" or "none".
	Mode string
}

// Provider is one way to run the model.
type Provider interface {
	Complete(ctx context.Context, r Request) (Result, error)
	Models(ctx context.Context) ([]string, error)
}

// ErrUnreachable is returned when the engine does not answer at all.
var ErrUnreachable = errors.New("engine unreachable")

// httpClient: per-request contexts bound every call; a redirect is followed only to the same host.
var httpClient = &http.Client{Timeout: 0, CheckRedirect: func(req *http.Request, via []*http.Request) error {
	if len(via) >= 3 || req.URL.Host != via[0].URL.Host {
		return http.ErrUseLastResponse
	}
	return nil
}}

// NormalizeURL trims a trailing slash and a trailing /v1, and requires http or https.
func NormalizeURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("not an http(s) URL: %q", raw)
	}
	if u.User != nil {
		return "", errors.New("credentials in the URL are not supported; use the API key field")
	}
	p := strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), "/v1")
	u.Path, u.RawQuery, u.Fragment = strings.TrimSuffix(p, "/"), "", ""
	return u.String(), nil
}

// OpenAI is a server speaking the OpenAI chat completions API (llama-server, LM Studio, vLLM, a cloud API...).
type OpenAI struct {
	Base   string // without /v1
	Model  string
	APIKey string
	// Extras: send top_k, repeat_penalty and the llama.cpp fields (servers that are not llama.cpp-like may refuse
	// unknown fields, so only the built-in engine and LM Studio get them).
	Extras    bool
	LlamaCpp  bool
	mu        sync.Mutex
	downgrade int // 0 schema, 1 json_object, 2 none: learnt from refusals
}

func (o *OpenAI) post(ctx context.Context, path string, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.Base+path, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if o.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+o.APIKey)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	return resp, nil
}

func (o *OpenAI) Models(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.Base+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	if o.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+o.APIKey)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("models: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Data))
	for _, d := range out.Data {
		names = append(names, d.ID)
	}
	return names, nil
}

func (o *OpenAI) Complete(ctx context.Context, r Request) (Result, error) {
	for {
		o.mu.Lock()
		level := o.downgrade
		o.mu.Unlock()
		res, status, body, err := o.complete(ctx, r, level)
		if err == nil {
			return res, nil
		}
		// A server that refuses response_format: try a weaker constraint, and remember it.
		if r.Schema != nil && level < 2 && status == 400 && strings.Contains(strings.ToLower(body), "response_format") {
			o.mu.Lock()
			if o.downgrade == level {
				o.downgrade++
			}
			o.mu.Unlock()
			continue
		}
		return Result{}, err
	}
}

func (o *OpenAI) complete(ctx context.Context, r Request, level int) (Result, int, string, error) {
	body := map[string]any{
		"messages":    r.Messages,
		"temperature": r.Temperature,
		"max_tokens":  r.MaxTokens,
		"stream":      r.OnToken != nil,
	}
	if o.Model != "" {
		body["model"] = o.Model
	}
	if o.Extras {
		body["top_k"] = r.TopK
		body["repeat_penalty"] = r.RepeatPenalty
	}
	if o.LlamaCpp {
		body["cache_prompt"] = true
		body["chat_template_kwargs"] = map[string]any{"enable_thinking": false}
	}
	mode := "none"
	if r.Schema != nil {
		switch level {
		case 0:
			mode = "schema"
			body["response_format"] = map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "decision", "strict": true, "schema": *r.Schema}}
		case 1:
			mode = "json"
			body["response_format"] = map[string]any{"type": "json_object"}
		}
	}
	if r.OnToken != nil {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	start := time.Now()
	resp, err := o.post(ctx, "/v1/chat/completions", body)
	if err != nil {
		return Result{}, 0, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return Result{}, resp.StatusCode, string(b), fmt.Errorf("engine: HTTP %d: %s", resp.StatusCode, playkit.Clip(playkit.OneLine(string(b)), 300))
	}
	res := Result{Mode: mode}
	type usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	}
	type timings struct {
		PredictedPerSecond float64 `json:"predicted_per_second"`
	}
	if r.OnToken == nil {
		var out struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
			Usage   usage    `json:"usage"`
			Timings *timings `json:"timings"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&out); err != nil {
			return Result{}, 0, "", err
		}
		if len(out.Choices) == 0 {
			return Result{}, 0, "", errors.New("engine: no choices")
		}
		res.Text = out.Choices[0].Message.Content
		res.PromptTokens, res.CompletionTokens = out.Usage.PromptTokens, out.Usage.CompletionTokens
		if out.Timings != nil {
			res.TokensPerSecond = out.Timings.PredictedPerSecond
		}
	} else {
		var b strings.Builder
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		var firstToken time.Time
		for sc.Scan() {
			line := sc.Text()
			data, ok := strings.CutPrefix(line, "data: ")
			if !ok || data == "[DONE]" {
				continue
			}
			var ev struct {
				Choices []struct {
					Delta struct {
						Content string `json:"content"`
					} `json:"delta"`
				} `json:"choices"`
				Usage   *usage   `json:"usage"`
				Timings *timings `json:"timings"`
			}
			if json.Unmarshal([]byte(data), &ev) != nil {
				continue
			}
			for _, c := range ev.Choices {
				if c.Delta.Content != "" {
					if firstToken.IsZero() {
						firstToken = time.Now()
					}
					b.WriteString(c.Delta.Content)
					r.OnToken(c.Delta.Content)
				}
			}
			if ev.Usage != nil {
				res.PromptTokens, res.CompletionTokens = ev.Usage.PromptTokens, ev.Usage.CompletionTokens
			}
			if ev.Timings != nil && ev.Timings.PredictedPerSecond > 0 {
				res.TokensPerSecond = ev.Timings.PredictedPerSecond
			}
		}
		if err := sc.Err(); err != nil {
			return Result{}, 0, "", err
		}
		res.Text = b.String()
	}
	res.Elapsed = time.Since(start)
	if res.TokensPerSecond == 0 && res.CompletionTokens > 0 && res.Elapsed > 0 {
		res.TokensPerSecond = float64(res.CompletionTokens) / res.Elapsed.Seconds()
	}
	return res, 0, "", nil
}

// Ollama speaks Ollama's own API, which takes a JSON Schema in `format`.
type Ollama struct {
	Base  string
	Model string
}

func (o *Ollama) Models(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.Base+"/api/tags", nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("ollama tags: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Models))
	for _, m := range out.Models {
		names = append(names, m.Name)
	}
	return names, nil
}

func (o *Ollama) Complete(ctx context.Context, r Request) (Result, error) {
	if o.Model == "" {
		return Result{}, errors.New("ollama: choose a model")
	}
	body := map[string]any{
		"model":    o.Model,
		"messages": r.Messages,
		"stream":   r.OnToken != nil,
		"think":    false,
		"options":  map[string]any{"temperature": r.Temperature, "top_k": r.TopK, "repeat_penalty": r.RepeatPenalty, "num_predict": r.MaxTokens},
	}
	mode := "none"
	if r.Schema != nil {
		body["format"] = *r.Schema
		mode = "schema"
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.Base+"/api/chat", bytes.NewReader(b))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	start := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		e, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Result{}, fmt.Errorf("ollama: HTTP %d: %s", resp.StatusCode, playkit.Clip(playkit.OneLine(string(e)), 300))
	}
	type chunk struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Done            bool  `json:"done"`
		PromptEvalCount int   `json:"prompt_eval_count"`
		EvalCount       int   `json:"eval_count"`
		EvalDuration    int64 `json:"eval_duration"`
	}
	res := Result{Mode: mode}
	var text strings.Builder
	dec := json.NewDecoder(io.LimitReader(resp.Body, 4<<20))
	for {
		var c chunk
		if err := dec.Decode(&c); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return Result{}, err
		}
		text.WriteString(c.Message.Content)
		if r.OnToken != nil && c.Message.Content != "" {
			r.OnToken(c.Message.Content)
		}
		if c.Done {
			res.PromptTokens, res.CompletionTokens = c.PromptEvalCount, c.EvalCount
			if c.EvalDuration > 0 {
				res.TokensPerSecond = float64(c.EvalCount) / (float64(c.EvalDuration) / 1e9)
			}
			break
		}
	}
	res.Text = text.String()
	res.Elapsed = time.Since(start)
	return res, nil
}
