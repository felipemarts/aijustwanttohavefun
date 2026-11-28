package engine

// Everything the built-in engine downloads is pinned here: an exact revision or release and the SHA-256 of every
// file. A download whose hash differs is deleted and refused. To move to a newer model or llama.cpp build, update
// these values from the publisher (Hugging Face API `tree/<revision>` gives the LFS sha256 of each file; the GitHub
// release API gives a `digest` per asset) and check the model card again.

// Model: LiquidAI/LFM3-1.7B-GGUF, Q4_K_M. Checked 2026-11-27: repository created 2026-10-24, licence
// "LFM Open License v1.0" (license_name lfm1.0). The weights are downloaded by the user's program from Hugging Face
// and never stored in or redistributed by this repository.
const (
	ModelRepo       = "LiquidAI/LFM3-1.7B-GGUF"
	ModelRevision   = "cd0c74c575b5c416f3011b5b4c298077f26ca8c2"
	ModelFile       = "LFM3-1.7B-Q4_K_M.gguf"
	ModelSize       = 1099627808
	ModelSHA256     = "3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4"
	ModelName       = "LFM3 1.7B (Q4_K_M)"
	ModelLicense    = "LFM Open License v1.0"
	ModelLicenseURL = "https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/blob/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LICENSE"
	// The model card asks for llama.cpp b11960 (v0.8.0) or newer.
	ModelURL = "https://huggingface.co/" + ModelRepo + "/resolve/" + ModelRevision + "/" + ModelFile
)

// llama.cpp: the stable release v1.1.0 (2026-11-26), whose binaries are the build b12774 (commit
// 171527522610996f5f0acf12334e185156ca8f44). CPU builds for Windows and Linux (they run everywhere; a GPU build
// would need matching drivers); the macOS builds include Metal.
const (
	LlamaRelease = "v1.1.0"
	LlamaBuild   = "b12774"
	LlamaCommit  = "171527522610996f5f0acf12334e185156ca8f44"
)

type LlamaAsset struct {
	File   string
	Size   int64
	SHA256 string
}

// LlamaAssets maps GOOS/GOARCH to the release asset for it.
var LlamaAssets = map[string]LlamaAsset{
	"darwin/arm64":  {"llama-b12774-bin-macos-arm64.tar.gz", 16889601, "70311c4751ed3221e63f47769327dd088d7400f76dcfb81c66ec843db165814d"},
	"darwin/amd64":  {"llama-b12774-bin-macos-x64.tar.gz", 12619002, "0368e3dbdae70065a928c130aa235efc84090bb7817c3267998f00df4e6ed862"},
	"linux/arm64":   {"llama-b12774-bin-ubuntu-arm64.tar.gz", 19014279, "068e15b27cfaf2733855c313baad26fbce84952cbb770500e806073c41aa4214"},
	"linux/amd64":   {"llama-b12774-bin-ubuntu-x64.tar.gz", 23454685, "ab5837cca2317cfb7ecb5f85b550934e7355cd9df74cdde6e106581457034dbb"},
	"windows/arm64": {"llama-b12774-bin-win-cpu-arm64.zip", 13357105, "0ba8524390eee562ce196a5a901ea26cc4af1ea539b932fef0e91f4a5f7c8b3c"},
	"windows/amd64": {"llama-b12774-bin-win-cpu-x64.zip", 25288075, "44b70b20f3374eec3d16a002beceefef33cc3565678caeb3eea5f6cacba61836"},
}

func llamaURL(a LlamaAsset) string {
	return "https://github.com/ggml-org/llama.cpp/releases/download/" + LlamaBuild + "/" + a.File
}
