import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  DEFAULT_MODEL_ID,
  isValidModelId,
  normalizeModelId,
  OPENROUTER_API_KEY_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  SUGGESTED_MODEL_IDS,
} from "./constants.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "./env.js";

export type InitSetupResult = {
  modelId: string | null;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedOpenRouterKey: boolean;
};

type InitSetupProps = {
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptStep = "langsmith" | "model" | "openrouter";

export function needsCredentialSetup(modelIdOverride?: string | null): boolean {
  return (
    !process.env[OPENROUTER_API_KEY_ENV_KEY] ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined
  );
}

export function InitSetup({
  modelIdOverride = null,
  onComplete,
  onError,
}: InitSetupProps) {
  const [step, setStep] = useState<PromptStep | null>(null);
  const [openRouterKey, setOpenRouterKey] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const initialStep = getInitialStep(modelIdOverride);

    if (initialStep === null) {
      onComplete({
        modelId:
          modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null,
        savedLangSmithKey: false,
        savedModelId: false,
        savedOpenRouterKey: false,
      });
      return;
    }

    setStep(initialStep);
  }, [modelIdOverride, onComplete]);

  useInput((inputValue, key) => {
    if (isSaving || step === null) {
      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    if (inputValue && !key.ctrl && !key.meta) {
      setInput((value) => value + inputValue);
    }
  });

  async function submit() {
    setError(null);

    if (step === "openrouter") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError("OpenRouter API key is required.");
        return;
      }

      setOpenRouterKey(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterOpenRouter(modelIdOverride);

      if (nextStep) {
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOpenRouterKey: trimmedInput,
      });
      return;
    }

    if (step === "model") {
      const selectedModelId = parseModelSelection(input);

      if (!selectedModelId) {
        setError("Enter a model number or a valid OpenRouter model ID.");
        return;
      }

      setModelId(selectedModelId);
      setInput("");

      if (process.env.LANGSMITH_API_KEY === undefined) {
        setStep("langsmith");
        return;
      }

      await completeSetup({
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextOpenRouterKey: openRouterKey,
      });
      return;
    }

    if (step === "langsmith") {
      const nextLangSmithKey = input.trim();

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await completeSetup({
        nextLangSmithKey,
        nextModelId: modelId,
        nextOpenRouterKey: openRouterKey,
      });
    }
  }

  type CompleteSetupOptions = {
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextOpenRouterKey: string | null;
  };

  async function completeSetup({
    nextLangSmithKey,
    nextModelId,
    nextOpenRouterKey,
  }: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates: Record<string, string> = {};

      if (nextOpenRouterKey !== null) {
        updates[OPENROUTER_API_KEY_ENV_KEY] = nextOpenRouterKey;
      }

      if (nextModelId !== null) {
        updates[OPENWIKI_MODEL_ID_ENV_KEY] = nextModelId;
      }

      if (nextLangSmithKey !== null) {
        updates.LANGSMITH_API_KEY = nextLangSmithKey;

        if (nextLangSmithKey.length > 0) {
          updates.LANGCHAIN_PROJECT = "openwiki";
          updates.LANGCHAIN_TRACING_V2 = "true";
        }
      }

      if (Object.keys(updates).length > 0) {
        await saveOpenWikiEnv(updates);
      }

      onComplete({
        modelId:
          nextModelId ??
          modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          null,
        savedLangSmithKey:
          nextLangSmithKey !== null && nextLangSmithKey.length > 0,
        savedModelId: nextModelId !== null,
        savedOpenRouterKey: nextOpenRouterKey !== null,
      });
    } catch (saveError) {
      onError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to complete OpenWiki credential setup.",
      );
    }
  }

  const needsCredentialPrompt = needsCredentialSetup(modelIdOverride);

  return (
    <Box flexDirection="column">
      <SetupHeader />

      <Box flexDirection="column" marginBottom={1}>
        <SetupStep
          label="OpenRouter key"
          state={
            process.env[OPENROUTER_API_KEY_ENV_KEY]
              ? "done"
              : step === "openrouter"
                ? "current"
                : "pending"
          }
          detail={
            process.env[OPENROUTER_API_KEY_ENV_KEY]
              ? "available from environment"
              : `save to ${openWikiEnvPath}`
          }
        />
        <SetupStep
          label="Model"
          state={
            modelIdOverride || process.env[OPENWIKI_MODEL_ID_ENV_KEY]
              ? "done"
              : step === "model"
                ? "current"
                : "pending"
          }
          detail={getModelSetupDetail(modelIdOverride)}
        />
        <SetupStep
          label="LangSmith"
          state={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "done"
              : step === "langsmith"
                ? "current"
                : "optional"
          }
          detail={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "available from environment"
              : "optional tracing key"
          }
        />
        <SetupStep label="OpenWiki" state="done" detail="agent setup" />
      </Box>

      <SetupPanel title="Prompt">
        {step ? (
          <Prompt step={step} input={input} />
        ) : (
          <Text>Inspecting OpenWiki setup...</Text>
        )}
      </SetupPanel>

      {needsCredentialPrompt ? (
        <Text color="gray">Secrets are masked and saved only after setup.</Text>
      ) : null}

      {error ? (
        <SetupPanel title="Error">
          <Text color="red">{error}</Text>
        </SetupPanel>
      ) : null}
      {isSaving ? (
        <SetupPanel title="Saving">
          <Text>Writing OpenWiki setup...</Text>
        </SetupPanel>
      ) : null}
    </Box>
  );
}

function SetupHeader() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">credential setup</Text>
      </Text>
      <Text>Configure OpenRouter and local defaults.</Text>
    </Box>
  );
}

type SetupStepProps = {
  label: string;
  state: "current" | "done" | "optional" | "pending";
  detail: string;
};

function SetupStep({ label, state, detail }: SetupStepProps) {
  const color =
    state === "done"
      ? "green"
      : state === "current"
        ? "yellow"
        : state === "optional"
          ? "cyan"
          : "gray";

  return (
    <Text>
      <Text color={color}>[{state.toUpperCase()}]</Text>{" "}
      <Text bold>{label.padEnd(16)}</Text> <Text color="gray">{detail}</Text>
    </Text>
  );
}

type SetupPanelProps = {
  title: string;
  children: React.ReactNode;
};

function SetupPanel({ title, children }: SetupPanelProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

type PromptProps = {
  step: PromptStep;
  input: string;
};

function Prompt({ step, input }: PromptProps) {
  if (step === "openrouter") {
    return (
      <Text>
        <Text color="gray">$</Text> {OPENROUTER_API_KEY_ENV_KEY}={" "}
        <Text color="yellow">{mask(input)}</Text>
      </Text>
    );
  }

  if (step === "model") {
    return (
      <Box flexDirection="column">
        <Text>
          Choose an OpenRouter model. Enter selects {DEFAULT_MODEL_ID}.
        </Text>
        {SUGGESTED_MODEL_IDS.map((model, index) => (
          <Text key={model}>
            <Text color={model === DEFAULT_MODEL_ID ? "green" : "gray"}>
              {`${index + 1}.`.padStart(3)}
            </Text>{" "}
            {model}
            {model === DEFAULT_MODEL_ID ? (
              <Text color="gray"> default</Text>
            ) : null}
          </Text>
        ))}
        <Text color="gray">Type a number or paste a custom model ID.</Text>
        <Text>
          <Text color="gray">$</Text> {OPENWIKI_MODEL_ID_ENV_KEY}={" "}
          <Text color="yellow">{input}</Text>
        </Text>
      </Box>
    );
  }

  if (step === "langsmith") {
    return (
      <Text>
        <Text color="gray">$</Text> LANGSMITH_API_KEY optional={" "}
        <Text color="yellow">{mask(input)}</Text>
      </Text>
    );
  }

  return null;
}

function getInitialStep(modelIdOverride?: string | null): PromptStep | null {
  if (!process.env[OPENROUTER_API_KEY_ENV_KEY]) {
    return "openrouter";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

function getNextStepAfterOpenRouter(
  modelIdOverride?: string | null,
): PromptStep | null {
  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  return null;
}

function getModelSetupDetail(modelIdOverride?: string | null): string {
  if (modelIdOverride) {
    return `using ${modelIdOverride} for this run`;
  }

  if (process.env[OPENWIKI_MODEL_ID_ENV_KEY]) {
    return process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? "";
  }

  return `default ${DEFAULT_MODEL_ID}`;
}

function parseModelSelection(value: string): string | null {
  const trimmedInput = value.trim();

  if (trimmedInput.length === 0) {
    return DEFAULT_MODEL_ID;
  }

  if (/^\d+$/u.test(trimmedInput)) {
    const selectedIndex = Number(trimmedInput) - 1;
    const selectedModelId = SUGGESTED_MODEL_IDS[selectedIndex];

    return selectedModelId ?? null;
  }

  const normalizedModelId = normalizeModelId(trimmedInput);

  return isValidModelId(normalizedModelId) ? normalizedModelId : null;
}

function mask(value: string): string {
  if (value.length === 0) {
    return "";
  }

  return "*".repeat(value.length);
}
