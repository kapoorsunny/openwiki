export const OPEN_WIKI_DIR = "openwiki";
export const UPDATE_METADATA_PATH = `${OPEN_WIKI_DIR}/.last-update.json`;
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const OPENWIKI_MODEL_ID_ENV_KEY = "OPENWIKI_MODEL_ID";
export const DEFAULT_MODEL_ID = "z-ai/glm-5.2";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const SUGGESTED_MODEL_IDS = [
  DEFAULT_MODEL_ID,
  "openrouter/fusion",
  "moonshotai/kimi-k2.7-code",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
];

export function normalizeModelId(value: string): string {
  return value.trim();
}

export function isValidModelId(value: string): boolean {
  const modelId = normalizeModelId(value);

  return (
    modelId.length > 0 &&
    modelId.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(modelId) &&
    !modelId.includes("://")
  );
}
