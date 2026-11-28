/**
 * The built-in model: the one place that pins it. The values are copied from the desktop core's
 * `clients/desktop/internal/engine/pins.go` (same file, same revision, so both clients run the same weights);
 * test/model-pin.test.ts fails when the two disagree. Sampling comes from playkit.json; the context size from the
 * desktop core's llama-server arguments (`--ctx-size 8192`).
 *
 * LiquidAI/LFM3-1.7B-GGUF, Q4_K_M. Licence "LFM Open License v1.0": the weights are downloaded by the user's device
 * from Hugging Face and never stored in or redistributed by this repository.
 */
const REPO = 'LiquidAI/LFM3-1.7B-GGUF';
/** A full 40-hex commit of the Hugging Face repo, never a branch name. */
const REVISION = 'cd0c74c575b5c416f3011b5b4c298077f26ca8c2';
const FILE = 'LFM3-1.7B-Q4_K_M.gguf';
/** Exact size in bytes. */
const BYTES = 1099627808;
/** Lower-case hex SHA-256 of the file (the LFS object id on Hugging Face). */
const SHA256 = '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4';
const NAME = 'LFM3 1.7B (Q4_K_M)';
const LICENSE = 'LFM Open License v1.0';
const LICENSE_URL = 'https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/blob/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LICENSE';
const CONTEXT = 8192;

export type BuiltinModel = {
  /** Display name for the interface and the licence notice. */
  name: string;
  repo: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  url: string;
  licenseName: string;
  licenseUrl: string;
  /** Context window the core asks the runtime for. */
  contextSize: number;
};

export function builtinModel(p: { repo: string; revision: string; file: string; bytes: number; sha256: string; name?: string; contextSize?: number; licenseName?: string; licenseUrl?: string }): BuiltinModel {
  const rev = p.revision || 'main';
  return {
    name: p.name ?? NAME,
    repo: p.repo,
    revision: p.revision,
    file: p.file,
    bytes: p.bytes,
    sha256: p.sha256.toLowerCase(),
    url: `https://huggingface.co/${p.repo}/resolve/${rev}/${p.file}`,
    licenseName: p.licenseName ?? LICENSE,
    licenseUrl: p.licenseUrl ?? `https://huggingface.co/${p.repo}/blob/${rev}/LICENSE`,
    contextSize: p.contextSize ?? CONTEXT,
  };
}

export const BUILTIN_MODEL: BuiltinModel = builtinModel({ repo: REPO, revision: REVISION, file: FILE, bytes: BYTES, sha256: SHA256, name: NAME, licenseName: LICENSE, licenseUrl: LICENSE_URL, contextSize: CONTEXT });

/** Whether the build carries a complete pin (revision, size and checksum). */
export function isPinned(m: BuiltinModel): boolean {
  return /^[0-9a-f]{40}$/.test(m.revision) && m.bytes > 0 && /^[0-9a-f]{64}$/.test(m.sha256);
}
