import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { loadOpenWikiEnv, openWikiEnvDir } from "../env.js";
import { createSystemPrompt, createUserPrompt } from "./prompt.js";
import type {
  OpenWikiCommand,
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./types.js";
import {
  DEFAULT_MODEL_ID,
  isValidModelId,
  normalizeModelId,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENROUTER_BASE_URL,
  OPENWIKI_MODEL_ID_ENV_KEY,
} from "../constants.js";
import { createRunContext, writeLastUpdateMetadata } from "./utils.js";

export async function runOpenWikiAgent(
  command: OpenWikiCommand,
  cwd = process.cwd(),
  options: OpenWikiRunOptions = {},
): Promise<OpenWikiRunResult> {
  emitDebug(options, `command=${command}`);
  emitDebug(options, `cwd=${cwd}`);
  emitDebug(
    options,
    `userMessage=${options.userMessage ? "provided" : "not-provided"}`,
  );
  emitDebug(options, `userMessage.followup=${options.isFollowup === true}`);
  emitDebug(
    options,
    `openrouter.baseUrl=${JSON.stringify(OPENROUTER_BASE_URL)}`,
  );
  emitDebug(options, `env.beforeLoad ${formatEnvironmentDebug()}`);

  await loadOpenWikiEnv();
  emitDebug(options, "env=loaded ~/.openwiki/.env");
  emitDebug(options, `env.afterLoad ${formatEnvironmentDebug()}`);
  ensureOpenRouterKey();
  emitDebug(options, "credentials=openrouter key present");
  const modelId = resolveModelId(options);
  emitDebug(options, `model=${modelId}`);

  const context = await createRunContext(command, cwd);
  emitDebug(options, "context=created");
  const model = await createModel(modelId);
  emitDebug(options, "model=initialized");
  const checkpointer = await createCheckpointer();
  emitDebug(options, `checkpointer=${formatUrlDebugValue(checkpointPath)}`);
  const threadId = createThreadId(cwd);
  emitDebug(options, `thread=${threadId}`);
  const agent = createDeepAgent({
    model,
    tools: [],
    checkpointer,
    backend: new FilesystemBackend({
      rootDir: cwd,
      virtualMode: true,
    }),
    systemPrompt: createSystemPrompt(command),
  });
  emitDebug(options, "agent=created");

  const input = {
    messages: [
      {
        role: "user",
        content: createRunUserMessage(command, context, options),
      },
    ],
  };

  emitDebug(options, "stream=opening modes=messages,tools subgraphs=true");
  const stream = await agent.stream(input, {
    configurable: {
      thread_id: threadId,
    },
    streamMode: ["messages", "tools"],
    subgraphs: true,
  });
  emitDebug(options, "stream=started modes=messages,tools subgraphs=true");

  let unhandledChunkCount = 0;

  for await (const chunk of stream) {
    const event = parseStreamEvent(chunk);

    if (event) {
      options.onEvent?.(event);
    } else if (options.debug && unhandledChunkCount < 3) {
      emitDebug(
        options,
        `stream.unhandledChunk ${describeStreamChunkShape(chunk)}`,
      );
      unhandledChunkCount += 1;
    }
  }
  emitDebug(options, "stream=completed");
  await chmodIfExists(checkpointPath, 0o600);

  await writeLastUpdateMetadata(command, cwd, modelId);
  emitDebug(options, "metadata=written");

  return {
    command,
    model: modelId,
  };
}

const checkpointPath = path.join(openWikiEnvDir, "openwiki.sqlite");

function createRunUserMessage(
  command: OpenWikiCommand,
  context: Awaited<ReturnType<typeof createRunContext>>,
  options: OpenWikiRunOptions,
): string {
  if (options.isFollowup === true && options.userMessage?.trim()) {
    return options.userMessage.trim();
  }

  return createUserPrompt(command, context, options.userMessage ?? null);
}

async function createCheckpointer(): Promise<SqliteSaver> {
  await mkdir(openWikiEnvDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmodIfExists(openWikiEnvDir, 0o700);

  return SqliteSaver.fromConnString(checkpointPath);
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function createThreadId(cwd: string): string {
  const digest = createHash("sha256").update(path.resolve(cwd)).digest("hex");

  return `openwiki-${digest.slice(0, 32)}`;
}

function emitDebug(options: OpenWikiRunOptions, message: string): void {
  if (!options.debug) {
    return;
  }

  options.onEvent?.({
    type: "debug",
    message,
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function ensureOpenRouterKey(): void {
  if (!process.env[OPENROUTER_API_KEY_ENV_KEY]) {
    throw new Error(
      `${OPENROUTER_API_KEY_ENV_KEY} is required to run the OpenWiki agent.`,
    );
  }
}

function resolveModelId(options: OpenWikiRunOptions): string {
  const rawModelId =
    options.modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    DEFAULT_MODEL_ID;
  const modelId = normalizeModelId(rawModelId);

  if (!isValidModelId(modelId)) {
    throw new Error(
      `Invalid OpenRouter model ID configured in ${OPENWIKI_MODEL_ID_ENV_KEY}.`,
    );
  }

  return modelId;
}

async function createModel(modelId: string) {
  return new ChatOpenRouter({
    apiKey: process.env[OPENROUTER_API_KEY_ENV_KEY],
    baseURL: OPENROUTER_BASE_URL,
    model: modelId,
    siteName: "OpenWiki",
  });
}

type NormalizedStreamEvent = {
  mode: string;
  payload: unknown;
};

function parseStreamEvent(chunk: unknown): OpenWikiRunEvent | null {
  const streamEvent = normalizeStreamEvent(chunk);

  if (!streamEvent) {
    return null;
  }

  if (streamEvent.mode === "messages") {
    const text = extractMessageText(streamEvent.payload);

    return text.length > 0
      ? {
          type: "text",
          text,
        }
      : null;
  }

  if (streamEvent.mode === "tools") {
    return parseToolStreamEvent(streamEvent.payload);
  }

  return null;
}

function normalizeStreamEvent(chunk: unknown): NormalizedStreamEvent | null {
  if (Array.isArray(chunk)) {
    if (chunk.length < 2) {
      return null;
    }

    const [mode, payload] = normalizeStreamChunk(chunk);

    return typeof mode === "string" ? { mode, payload } : null;
  }

  if (!isRecord(chunk)) {
    return null;
  }

  const toolEvent = getStringRecordValue(chunk, "event");

  if (toolEvent?.startsWith("on_tool_")) {
    return {
      mode: "tools",
      payload: chunk,
    };
  }

  const method = getStringRecordValue(chunk, "method");

  if (!method) {
    return null;
  }

  return {
    mode: method,
    payload: getProtocolEventPayload(chunk),
  };
}

function normalizeStreamChunk(chunk: unknown[]): [unknown, unknown] {
  if (Array.isArray(chunk[0]) && chunk.length >= 3) {
    return [chunk[1], chunk[2]];
  }

  return [chunk[0], chunk[1]];
}

function extractMessageText(payload: unknown): string {
  return extractMessageTextValue(payload, new Set());
}

function extractMessageTextValue(payload: unknown, seen: Set<object>): string {
  if (typeof payload === "string") {
    return payload;
  }

  if (Array.isArray(payload)) {
    if (payload.length === 2 && isStreamMessageTuplePayload(payload)) {
      return extractMessageTextValue(payload[0], seen);
    }

    for (const item of payload) {
      const text = extractMessageTextValue(item, seen);

      if (text.length > 0) {
        return text;
      }
    }

    return payload.map((item) => extractContentBlockText(item, seen)).join("");
  }

  if (!isRecord(payload) || seen.has(payload)) {
    return "";
  }

  seen.add(payload);

  const protocolText = extractProtocolMessageText(payload, seen);

  if (protocolText !== null) {
    return protocolText;
  }

  if (isRecord(payload.chunk)) {
    const text = extractMessageTextValue(payload.chunk, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (isRecord(payload.message)) {
    const text = extractMessageTextValue(payload.message, seen);

    if (text.length > 0) {
      return text;
    }
  }

  if (!shouldReadMessageRecord(payload)) {
    return "";
  }

  const contentText = extractContentText(payload.content, seen);

  if (contentText.length > 0) {
    return contentText;
  }

  for (const key of [
    "text",
    "output",
    "generations",
    "messages",
    "kwargs",
    "lc_kwargs",
  ]) {
    const text = extractMessageTextValue(payload[key], seen);

    if (text.length > 0) {
      return text;
    }
  }

  return "";
}

function isStreamMessageTuplePayload(payload: unknown[]): boolean {
  const [message, metadata] = payload;

  if (!isRecord(metadata) || !isMessageLikeRecord(message)) {
    return false;
  }

  if (
    "langgraph_node" in metadata ||
    "run_id" in metadata ||
    "tags" in metadata ||
    "metadata" in metadata
  ) {
    return true;
  }

  return (
    "langgraph_node" in message ||
    "checkpoint_ns" in message ||
    "thread_id" in message
  );
}

function isMessageLikeRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    "content" in value ||
    "text" in value ||
    "kwargs" in value ||
    "lc_kwargs" in value ||
    typeof value._getType === "function" ||
    getMessageRole(value) !== null ||
    hasSerializedMessageId(value)
  );
}

function extractProtocolMessageText(
  payload: Record<string, unknown>,
  seen: Set<object>,
): string | null {
  const event = getStringRecordValue(payload, "event");

  if (!event) {
    return null;
  }

  if (event === "content-block-delta") {
    return extractContentDeltaText(payload.delta, seen);
  }

  if (event === "content-block-start") {
    return extractContentText(payload.content, seen);
  }

  if (
    event === "message-start" ||
    event === "message-finish" ||
    event === "content-block-finish" ||
    event === "error"
  ) {
    return "";
  }

  return null;
}

function extractContentText(content: unknown, seen: Set<object>): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => extractContentBlockText(block, seen))
      .join("");
  }

  if (isRecord(content)) {
    return extractContentBlockText(content, seen);
  }

  return "";
}

function extractContentDeltaText(delta: unknown, seen: Set<object>): string {
  if (typeof delta === "string") {
    return delta;
  }

  if (!isRecord(delta)) {
    return "";
  }

  const type = getStringRecordValue(delta, "type");

  if (type === "text-delta") {
    return typeof delta.text === "string" ? delta.text : "";
  }

  if (type === "block-delta") {
    return extractContentBlockText(delta.fields, seen);
  }

  if (typeof delta.text === "string") {
    return delta.text;
  }

  if (typeof delta.delta === "string") {
    return delta.delta;
  }

  return "";
}

function extractContentBlockText(block: unknown, seen: Set<object>): string {
  if (typeof block === "string") {
    return block;
  }

  if (!isRecord(block)) {
    return "";
  }

  const type = getStringRecordValue(block, "type");

  if (type?.includes("tool") || type?.includes("reasoning")) {
    return "";
  }

  for (const key of ["text", "content", "output_text"]) {
    const text = block[key];

    if (typeof text === "string") {
      return text;
    }
  }

  if (isRecord(block.fields)) {
    return extractContentBlockText(block.fields, seen);
  }

  if (isRecord(block.delta)) {
    return extractContentDeltaText(block.delta, seen);
  }

  return "";
}

function shouldReadMessageRecord(value: Record<string, unknown>): boolean {
  const role = getMessageRole(value);

  return role === null || role === "ai" || role === "assistant";
}

function getMessageRole(value: Record<string, unknown>): string | null {
  for (const key of ["role", "type"]) {
    const role = getStringRecordValue(value, key);

    if (isMessageRole(role)) {
      return role;
    }
  }

  const serializedType = getSerializedMessageType(value);

  if (serializedType === "AIMessage" || serializedType === "AIMessageChunk") {
    return "ai";
  }

  if (
    serializedType === "HumanMessage" ||
    serializedType === "SystemMessage" ||
    serializedType === "ToolMessage"
  ) {
    return serializedType.replace("Message", "").toLowerCase();
  }

  const getType = value._getType;

  if (typeof getType !== "function") {
    return null;
  }

  try {
    const role = getType.call(value);

    return isMessageRole(role) ? role : null;
  } catch {
    return null;
  }
}

function hasSerializedMessageId(value: Record<string, unknown>): boolean {
  return getSerializedMessageType(value) !== null;
}

function getSerializedMessageType(
  value: Record<string, unknown>,
): string | null {
  if (!Array.isArray(value.id)) {
    return null;
  }

  return (
    value.id
      .filter((part): part is string => typeof part === "string")
      .at(-1) ?? null
  );
}

function isMessageRole(value: unknown): value is string {
  return (
    value === "ai" ||
    value === "assistant" ||
    value === "human" ||
    value === "system" ||
    value === "tool"
  );
}

function getProtocolEventPayload(event: Record<string, unknown>): unknown {
  const params = event.params;

  if (isRecord(params) && "data" in params) {
    return params.data;
  }

  if ("data" in event) {
    return event.data;
  }

  if ("payload" in event) {
    return event.payload;
  }

  return event;
}

function parseToolStreamEvent(payload: unknown): OpenWikiRunEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const event = getStringRecordValue(payload, "event");

  if (event === "on_tool_start" || event === "tool-started") {
    const name =
      getStringRecordValue(payload, "name") ??
      getStringRecordValue(payload, "tool_name") ??
      "tool";
    const id =
      getStringRecordValue(payload, "toolCallId") ??
      getStringRecordValue(payload, "tool_call_id") ??
      createSyntheticToolCallId(name, payload.input);

    return {
      type: "tool_start",
      call: `${name}(${formatToolArgs(payload.input)})`,
      id,
      input: payload.input,
      name,
    };
  }

  if (
    event === "on_tool_end" ||
    event === "tool-finished" ||
    event === "on_tool_error" ||
    event === "tool-error"
  ) {
    const name =
      getStringRecordValue(payload, "name") ??
      getStringRecordValue(payload, "tool_name") ??
      "tool";
    const id =
      getStringRecordValue(payload, "toolCallId") ??
      getStringRecordValue(payload, "tool_call_id") ??
      createSyntheticToolCallId(name, payload.input);

    return {
      type: "tool_end",
      id,
      name,
      status:
        event === "on_tool_error" || event === "tool-error"
          ? "error"
          : "finished",
    };
  }

  return null;
}

function formatToolArgs(input: unknown): string {
  const value = parseStringifiedJson(input);

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, argValue]) => `${key}=${formatToolValue(argValue)}`)
      .join(", ");
  }

  if (Array.isArray(value)) {
    return value.map(formatToolValue).join(", ");
  }

  if (value === undefined || value === null) {
    return "";
  }

  return formatToolValue(value);
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return JSON.stringify(value) ?? String(value);
}

function parseStringifiedJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function createSyntheticToolCallId(name: string, input: unknown): string {
  return `${name}:${formatToolValue(input)}`;
}

function getStringRecordValue(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeStreamChunkShape(chunk: unknown): string {
  if (Array.isArray(chunk)) {
    return `array(length=${chunk.length}, items=${chunk
      .slice(0, 3)
      .map(describeValueShape)
      .join(",")})`;
  }

  return describeValueShape(chunk);
}

function describeValueShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(length=${value.length})`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const suffix = keys.length > 8 ? ",..." : "";

    return `object(keys=${keys.slice(0, 8).join(",")}${suffix})`;
  }

  return typeof value;
}

function formatEnvironmentDebug(): string {
  const keys = [
    OPENROUTER_API_KEY_ENV_KEY,
    OPENWIKI_MODEL_ID_ENV_KEY,
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_PROJECT",
    "LANGCHAIN_ENDPOINT",
  ];

  return keys
    .map((key) => `${key}:${formatDebugValue(key, process.env[key])}`)
    .join(" ");
}

function formatDebugValue(key: string, value: string | undefined): string {
  if (value === undefined) {
    return "unset";
  }

  if (key === "LANGCHAIN_ENDPOINT") {
    return formatUrlDebugValue(value);
  }

  if (key.endsWith("_API_KEY")) {
    return `set(length=${value.length})`;
  }

  if (key === OPENWIKI_MODEL_ID_ENV_KEY) {
    return `set(value=${JSON.stringify(value)})`;
  }

  if (value.length <= 10) {
    return `set(length=${value.length})`;
  }

  return `set(length=${value.length}, preview=${JSON.stringify(
    `${value.slice(0, 6)}...${value.slice(-4)}`,
  )})`;
}

function formatUrlDebugValue(value: string): string {
  try {
    const url = new URL(value);
    const redacted: string[] = [];

    if (url.username || url.password) {
      redacted.push("auth");
      url.username = "";
      url.password = "";
    }

    if (url.search) {
      redacted.push("query");
      url.search = "";
    }

    if (url.hash) {
      redacted.push("hash");
      url.hash = "";
    }

    const redactionSuffix =
      redacted.length > 0 ? `, redacted=${redacted.join("+")}` : "";

    return `set(url=${JSON.stringify(url.toString())}${redactionSuffix})`;
  } catch {
    return `set(length=${value.length}, preview=${JSON.stringify(
      `${value.slice(0, 6)}...${value.slice(-4)}`,
    )})`;
  }
}
