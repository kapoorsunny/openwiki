#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { marked, type Token, type Tokens } from "marked";
import {
  helpContent,
  isDevelopmentMode,
  parseCommand,
  type CliCommand,
  type HelpRow,
} from "./commands.js";
import {
  InitSetup,
  needsCredentialSetup,
  type InitSetupResult,
} from "./credentials.js";
import {
  getCredentialDiagnostics,
  loadOpenWikiEnv,
  type CredentialDiagnostic,
} from "./env.js";
import { runOpenWikiAgent } from "./agent/index.js";
import {
  type OpenWikiRunEvent,
  type OpenWikiRunResult,
} from "./agent/types.js";
import {
  DEFAULT_MODEL_ID,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  OPEN_WIKI_DIR,
} from "./constants.js";
import type { OpenWikiCommand } from "./agent/types.js";

const OPENWIKI_VERSION = "0.1.0";

type RunState =
  | { status: "idle" }
  | { status: "init-setup-saved"; result: InitSetupResult }
  | { status: "init-declined"; path: string }
  | {
      status: "running";
      command: OpenWikiCommand;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "success";
      result: OpenWikiRunResult;
      log: RunLogItem[];
      credentialDiagnostics?: CredentialDiagnostic[];
    }
  | {
      status: "error";
      message: string;
      credentialDiagnostics?: CredentialDiagnostic[];
      errorDiagnostics?: ErrorDiagnostic[];
    };

type RunLogItem = {
  call?: string;
  doneContent?: string;
  id: number;
  status?: "done" | "error" | "running";
  toolCallId?: string;
  toolName?: string;
  type: "debug" | "text" | "tool";
  content: string;
};

type CompletedRun = {
  id: number;
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  message: string | null;
  result: OpenWikiRunResult;
};

type ErrorDiagnostic = {
  label: string;
  value: string;
};

type AppProps = {
  command: CliCommand;
};

function App({ command }: AppProps) {
  const app = useApp();
  const startupModelId = command.kind === "run" ? command.modelId : null;
  const activeRunId = useRef(0);
  const mountedRef = useRef(false);
  const nextLogId = useRef(1);
  const nextCompletedRunId = useRef(1);
  const activeRunCredentialDiagnostics = useRef<
    CredentialDiagnostic[] | undefined
  >(undefined);
  const activeRunLog = useRef<RunLogItem[]>([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [completedRuns, setCompletedRuns] = useState<CompletedRun[]>([]);
  const [activeUserMessage, setActiveUserMessage] = useState<string | null>(
    command.kind === "run" ? command.userMessage : null,
  );
  const [activeMessageIsFollowup, setActiveMessageIsFollowup] = useState(false);
  const [resolvedCommand, setResolvedCommand] =
    useState<OpenWikiCommand | null>(null);
  const [initPromptPath, setInitPromptPath] = useState<string | null>(null);
  const shouldRunInteractiveCredentialSetup =
    command.kind === "run" &&
    resolvedCommand !== null &&
    !command.dryRun &&
    process.stdin.isTTY &&
    runState.status === "idle" &&
    needsCredentialSetup(command.modelId);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (command.kind === "help" || command.kind === "error") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.dryRun) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (command.kind !== "run") {
      return;
    }

    if (resolvedCommand === null) {
      if (initPromptPath !== null) {
        return;
      }

      resolveRunCommand(process.cwd())
        .then((nextCommand) => {
          if (!mountedRef.current) {
            return;
          }

          if (nextCommand === "init") {
            if (!process.stdin.isTTY) {
              setRunState({
                status: "error",
                message: `No OpenWiki detected at ${path.join(
                  process.cwd(),
                  OPEN_WIKI_DIR,
                )}. Run openwiki in an interactive terminal to initialize it.`,
              });
              return;
            }

            setInitPromptPath(path.join(process.cwd(), OPEN_WIKI_DIR));
            return;
          }

          setResolvedCommand(nextCommand);
        })
        .catch((error: unknown) => {
          if (!mountedRef.current) {
            return;
          }

          setRunState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to inspect OpenWiki directory.",
          });
        });

      return;
    }

    if (!process.env[OPENROUTER_API_KEY_ENV_KEY] && !process.stdin.isTTY) {
      setRunState({
        status: "error",
        message: `${OPENROUTER_API_KEY_ENV_KEY} is required. Run openwiki in an interactive terminal to save credentials.`,
      });
      return;
    }

    if (shouldRunInteractiveCredentialSetup) {
      return;
    }

    if (runState.status !== "idle" && runState.status !== "init-setup-saved") {
      return;
    }

    const runId = activeRunId.current + 1;
    const runMessage = activeUserMessage;

    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setRunState({
      status: "running",
      command: resolvedCommand,
      log: [],
    });

    if (shouldShowCredentialDiagnostics()) {
      void getCredentialDiagnostics()
        .catch(() => undefined)
        .then((credentialDiagnostics) => {
          if (
            !mountedRef.current ||
            activeRunId.current !== runId ||
            !credentialDiagnostics
          ) {
            return;
          }

          setRunState((currentState) =>
            updateRunningCredentialDiagnostics(
              currentState,
              credentialDiagnostics,
              activeRunCredentialDiagnostics,
            ),
          );
        });
    }

    runOpenWikiAgent(resolvedCommand, process.cwd(), {
      debug: isDebugMode(),
      isFollowup: activeMessageIsFollowup,
      modelId: command.modelId,
      userMessage: activeUserMessage,
      onEvent: (event) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        activeRunLog.current = appendRunLogEvent(
          activeRunLog.current,
          event,
          nextLogId,
        );
        setRunState((currentState) =>
          currentState.status === "running"
            ? {
                ...currentState,
                log: activeRunLog.current,
              }
            : currentState,
        );
      },
    })
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        setRunState({
          status: "success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
        setCompletedRuns((runs) => [
          ...runs,
          {
            id: nextCompletedRunId.current,
            command: result.command,
            credentialDiagnostics: activeRunCredentialDiagnostics.current,
            log: activeRunLog.current,
            message: runMessage,
            result,
          },
        ]);
        nextCompletedRunId.current += 1;
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
            });
          });
      });
  }, [
    app,
    command,
    activeMessageIsFollowup,
    activeUserMessage,
    initPromptPath,
    resolvedCommand,
    runState.status,
    shouldRunInteractiveCredentialSetup,
  ]);

  useEffect(() => {
    if (runState.status === "error") {
      process.exitCode = 1;
      app.exit();
      return;
    }

    if (runState.status === "init-declined") {
      process.exitCode = 0;
      app.exit();
    }
  }, [app, runState.status]);

  if (command.kind === "help") {
    return <HelpView />;
  }

  if (command.kind === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={null} subtitle="Command failed" />
        <StatusLine tone="error" label="Error" value={command.message} />
        <HelpView />
      </Box>
    );
  }

  if (command.kind === "run" && command.dryRun) {
    return (
      <DryRunView modelId={command.modelId} userMessage={command.userMessage} />
    );
  }

  if (command.kind === "run" && initPromptPath !== null) {
    return (
      <InitializePrompt
        path={initPromptPath}
        onAccept={() => {
          setInitPromptPath(null);
          setResolvedCommand("init");
        }}
        onDecline={() => {
          setInitPromptPath(null);
          setRunState({
            status: "init-declined",
            path: initPromptPath,
          });
        }}
      />
    );
  }

  if (shouldRunInteractiveCredentialSetup) {
    return (
      <InitSetup
        modelIdOverride={command.modelId}
        onComplete={(result) => {
          setRunState({ status: "init-setup-saved", result });
        }}
        onError={(message) => {
          setRunState({ status: "error", message });
        }}
      />
    );
  }

  if (runState.status === "init-setup-saved") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? startupModelId}
          subtitle="Credential setup"
        />
        {runState.result.savedOpenRouterKey ||
        runState.result.savedModelId ||
        runState.result.savedLangSmithKey ? (
          <StatusLine tone="success" label="Credentials" value="saved" />
        ) : null}
        {runState.result.modelId ? (
          <StatusLine
            tone="muted"
            label="Model"
            value={runState.result.modelId}
          />
        ) : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "init-declined") {
    return (
      <Box flexDirection="column">
        <Header modelId={startupModelId} subtitle="Initialization skipped" />
        <StatusLine
          tone="muted"
          label="OpenWiki"
          value={`No documentation was created at ${runState.path}.`}
        />
      </Box>
    );
  }

  if (runState.status === "running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command={runState.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={startupModelId}
        />
      </Box>
    );
  }

  if (runState.status === "success") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.model}
          subtitle="Ready for follow-up"
        />
        <ChatHistory runs={completedRuns} />
        <ChatInput
          onSubmit={(message) => {
            if (isExitMessage(message)) {
              process.exitCode = 0;
              app.exit();
              return;
            }

            setActiveUserMessage(message);
            setActiveMessageIsFollowup(true);
            setResolvedCommand("update");
            setRunState({ status: "idle" });
          }}
        />
      </Box>
    );
  }

  if (runState.status === "idle" && completedRuns.length > 0) {
    return (
      <Box flexDirection="column">
        <Header modelId={startupModelId} subtitle="Starting follow-up" />
        <ChatHistory runs={completedRuns} />
        {activeUserMessage ? <PromptBlock message={activeUserMessage} /> : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={startupModelId} subtitle="Run failed" />
        <StatusLine tone="error" label="Error" value={runState.message} />
        {runState.credentialDiagnostics ? (
          <CredentialDiagnosticsPanel
            diagnostics={runState.credentialDiagnostics}
          />
        ) : null}
        {runState.errorDiagnostics && runState.errorDiagnostics.length > 0 ? (
          <ErrorDiagnosticsPanel diagnostics={runState.errorDiagnostics} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header modelId={startupModelId} subtitle="Starting" />
    </Box>
  );
}

function HelpView() {
  return (
    <Box flexDirection="column">
      <Header modelId={null} subtitle={helpContent.description} />

      <Panel title="Usage">
        {helpContent.usage.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
      </Panel>

      <Panel title="Commands">
        <Rows rows={helpContent.commands} />
      </Panel>

      <Panel title="Options">
        <Rows rows={helpContent.options} />
      </Panel>

      {isDevelopmentMode() ? (
        <Panel title="Development Options">
          <Rows rows={helpContent.developmentOptions} />
        </Panel>
      ) : null}

      <Panel title="Examples">
        {helpContent.examples.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
        {isDevelopmentMode()
          ? helpContent.developmentExamples.map((line) => (
              <Text key={line}> {line}</Text>
            ))
          : null}
      </Panel>
    </Box>
  );
}

function DryRunView({
  modelId,
  userMessage,
}: {
  modelId: string | null;
  userMessage: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Header modelId={modelId} subtitle="Development dry run" />
      <Panel title="Execution Plan">
        <StatusLine tone="active" label="Command" value="openwiki" />
        <StatusLine
          tone="muted"
          label="Mode"
          value={`resolved from ${OPEN_WIKI_DIR}/ existence`}
        />
        <StatusLine
          tone="muted"
          label="Credentials"
          value="not read or requested"
        />
        <StatusLine
          tone="muted"
          label="Model"
          value={modelId ?? `saved setting or ${DEFAULT_MODEL_ID}`}
        />
        <StatusLine tone="muted" label="Agent" value="not invoked" />
        <StatusLine tone="muted" label="Writes" value="no files or metadata" />
        <StatusLine tone="muted" label="Output" value={`${OPEN_WIKI_DIR}/`} />
        {userMessage ? (
          <StatusLine tone="muted" label="Message" value={userMessage} />
        ) : null}
      </Panel>
    </Box>
  );
}

type InitializePromptProps = {
  path: string;
  onAccept: () => void;
  onDecline: () => void;
};

function InitializePrompt({
  path,
  onAccept,
  onDecline,
}: InitializePromptProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((inputValue, key) => {
    if (key.return) {
      const answer = parseYesNoAnswer(input);

      if (answer === null) {
        setError("Enter yes or no.");
        return;
      }

      if (answer) {
        onAccept();
        return;
      }

      onDecline();
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

  return (
    <Box flexDirection="column">
      <Header modelId={null} subtitle="No OpenWiki detected" />
      <Panel title="Initialize">
        <Text>
          No OpenWiki detected. Would you like to initialize a new project at{" "}
          {path}?
        </Text>
        <Text>
          <Text color="gray">$</Text> Initialize OpenWiki?{" "}
          <Text color="cyan">Y/n</Text> {input}
        </Text>
      </Panel>
      {error ? (
        <Panel title="Error">
          <Text color="red">{error}</Text>
        </Panel>
      ) : null}
    </Box>
  );
}

function CredentialDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: CredentialDiagnostic[];
}) {
  return (
    <Panel title="Credential Diagnostics">
      <Text color="gray">Raw secret values are intentionally not printed.</Text>
      {diagnostics.map((diagnostic) => (
        <Box flexDirection="column" key={diagnostic.key} marginTop={1}>
          <Text>
            <Text bold>{diagnostic.key}</Text>{" "}
            <Text color="gray">source={diagnostic.source}</Text>
          </Text>
          <Text>
            length={diagnostic.length ?? "unset"} preview={diagnostic.preview}
          </Text>
          <Text color={diagnostic.warnings.length > 0 ? "yellow" : "gray"}>
            warnings=
            {diagnostic.warnings.length > 0
              ? diagnostic.warnings.join(", ")
              : "none"}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

function ErrorDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: ErrorDiagnostic[];
}) {
  return (
    <Panel title="Error Diagnostics">
      <Text color="gray">
        OPENWIKI_DEBUG=1 is enabled. Only allowlisted, non-secret error fields
        are shown.
      </Text>
      {diagnostics.map((diagnostic) => (
        <Text key={diagnostic.label}>
          <Text bold>{diagnostic.label}</Text> {diagnostic.value}
        </Text>
      ))}
    </Panel>
  );
}

function Header({
  modelId,
  subtitle,
}: {
  modelId?: string | null;
  subtitle: string;
}) {
  const displayModelId = sanitizeHeaderValue(
    modelId ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? DEFAULT_MODEL_ID,
  );
  const displayDirectory = sanitizeHeaderValue(formatCwd(process.cwd()), 120);
  const tracingEnabled =
    process.env.LANGCHAIN_TRACING_V2 === "true" &&
    Boolean(process.env.LANGSMITH_API_KEY);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          {"  ___                  __        ___ _    _ "}
          {"\n"}
          {" / _ \\ _ __   ___ _ __ \\ \\      / (_) | _(_)"}
          {"\n"}
          {"| | | | '_ \\ / _ \\ '_ \\ \\ \\ /\\ / /| | |/ / |"}
          {"\n"}
          {"| |_| | |_) |  __/ | | | \\ V  V / | |   <| |"}
          {"\n"}
          {" \\___/| .__/ \\___|_| |_|  \\_/\\_/  |_|_|\\_\\_|"}
          {"\n"}
          {"      |_|"}
        </Text>
      </Box>
      <Box
        borderColor="cyan"
        borderStyle="round"
        flexDirection="column"
        marginBottom={1}
        paddingX={1}
      >
        <Text>
          <Text color="cyan">{">_ "}</Text>
          <Text bold>OpenWiki</Text>{" "}
          <Text color="gray">v{OPENWIKI_VERSION}</Text>{" "}
          <Text color="gray">agent docs for codebases</Text>
        </Text>
        <Text>
          <Text color="gray">model: </Text>
          <Text color="white">{displayModelId}</Text>
        </Text>
        <Text>
          <Text color="gray">directory: </Text>
          <Text color="white">{displayDirectory}</Text>
        </Text>
      </Box>
      <Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          {tracingEnabled ? "* " : "- "}
        </Text>
        <Text color={tracingEnabled ? "green" : "gray"}>
          LangSmith tracing {tracingEnabled ? "enabled" : "disabled"}
        </Text>
        <Text color="gray"> - </Text>
        <Text color="cyan">{subtitle}</Text>
      </Text>
      <Text color="gray">
        Tip: ask for a docs change, or use /exit when you are done.
      </Text>
    </Box>
  );
}

type StatusLineProps = {
  tone: "active" | "error" | "muted" | "success";
  label: string;
  value: string;
};

function StatusLine({ tone, label, value }: StatusLineProps) {
  const color =
    tone === "success"
      ? "green"
      : tone === "error"
        ? "red"
        : tone === "active"
          ? "yellow"
          : "gray";

  return (
    <Text>
      <Text color={color}>* </Text>
      <Text bold color={color}>
        {label}
      </Text>{" "}
      <Text color={tone === "muted" ? "gray" : undefined}>{value}</Text>
    </Text>
  );
}

type RunViewProps = {
  command: OpenWikiCommand;
  credentialDiagnostics?: CredentialDiagnostic[];
  log: RunLogItem[];
  done?: boolean;
  message?: string | null;
  modelId?: string | null;
};

function RunView({
  command,
  credentialDiagnostics,
  log,
  done = false,
  message = null,
  modelId = null,
}: RunViewProps) {
  return (
    <Box flexDirection="column">
      <Header
        modelId={modelId}
        subtitle={done ? "Run complete" : "Agent running"}
      />
      {message ? <PromptBlock message={message} /> : null}
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={done ? "green" : "cyan"}>* </Text>
          <Text bold>{done ? "Complete" : "Working"}</Text>{" "}
          <Text color="gray">openwiki {command}</Text>
          {!done ? <Text color="gray"> - streaming</Text> : null}
        </Text>
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {log.length > 0 ? (
            log.map((item) => <RunLogLine item={item} key={item.id} />)
          ) : (
            <Text color="gray">Waiting for model output...</Text>
          )}
        </Box>
      </Box>
      {credentialDiagnostics ? (
        <CredentialDiagnosticsPanel diagnostics={credentialDiagnostics} />
      ) : null}
    </Box>
  );
}

function RunLogLine({ item }: { item: RunLogItem }) {
  if (item.type === "tool") {
    const color =
      item.status === "error"
        ? "red"
        : item.status === "running"
          ? "yellow"
          : "magenta";

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={color}>* </Text>
          <Text bold>{item.content}</Text>
        </Text>
        {item.status === "running" && item.call ? (
          <Text color="gray"> | {truncateLogOutput(item.call, "")}</Text>
        ) : null}
      </Box>
    );
  }

  if (item.type === "debug") {
    return (
      <Text>
        <Text color="gray">- </Text>
        <Text color="gray">{item.content}</Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="row">
      <Text color="white">* </Text>
      <Box flexDirection="column">
        <MarkdownText markdown={item.content.trim()} />
      </Box>
    </Box>
  );
}

function MarkdownText({ markdown }: { markdown: string }) {
  const tokens = marked.lexer(markdown, {
    async: false,
    gfm: true,
  });

  return (
    <Box flexDirection="column">
      {tokens.map((token, index) => (
        <MarkdownBlock
          index={index}
          key={`${token.type}-${index}`}
          token={token}
        />
      ))}
    </Box>
  );
}

function MarkdownBlock({ index, token }: { index: number; token: Token }) {
  if (token.type === "space" || token.type === "def" || token.type === "hr") {
    return null;
  }

  if (token.type === "paragraph") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "heading") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "list") {
    return (
      <Box flexDirection="column">
        {(token as Tokens.List).items.map((item, itemIndex) => (
          <Text key={`${index}-${itemIndex}`} wrap="wrap">
            <Text color="gray">
              {(token as Tokens.List).ordered
                ? `${Number((token as Tokens.List).start || 1) + itemIndex}. `
                : "- "}
            </Text>
            <InlineMarkdown tokens={getTokenChildren(item)} />
          </Text>
        ))}
      </Box>
    );
  }

  if (token.type === "code") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "blockquote") {
    return (
      <Text wrap="wrap">
        <Text color="gray">| </Text>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "table") {
    return <Text color="gray">{renderPlainTable(token as Tokens.Table)}</Text>;
  }

  if (token.type === "html") {
    return <Text wrap="wrap">{renderHtmlToken(token)}</Text>;
  }

  if (token.type === "text") {
    return (
      <Text wrap="wrap">
        <InlineMarkdown tokens={token.tokens ?? [token]} />
      </Text>
    );
  }

  return <Text wrap="wrap">{token.raw}</Text>;
}

function InlineMarkdown({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <InlineMarkdownToken key={`${token.type}-${index}`} token={token} />
      ))}
    </>
  );
}

function InlineMarkdownToken({ token }: { token: Token }) {
  if (token.type === "text" || token.type === "escape") {
    return <>{token.text}</>;
  }

  if (token.type === "strong") {
    return (
      <Text bold>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "em") {
    return (
      <Text italic>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "link") {
    return (
      <Text underline>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "codespan") {
    return <Text color="gray">{token.text}</Text>;
  }

  if (token.type === "br") {
    return <>{"\n"}</>;
  }

  if (token.type === "del") {
    return (
      <Text strikethrough>
        <InlineMarkdown tokens={getTokenChildren(token)} />
      </Text>
    );
  }

  if (token.type === "html") {
    return <>{renderHtmlToken(token)}</>;
  }

  if ("tokens" in token && Array.isArray(token.tokens)) {
    return <InlineMarkdown tokens={token.tokens} />;
  }

  return <>{token.raw}</>;
}

function getTokenChildren(token: Token): Token[] {
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function renderPlainTable(token: Tokens.Table): string {
  const header = token.header.map((cell) => cell.text).join(" | ");
  const rows = token.rows.map((row) =>
    row.map((cell) => cell.text).join(" | "),
  );

  return [header, ...rows].filter(Boolean).join("\n");
}

function renderHtmlToken(token: Token): React.ReactNode {
  const text =
    "text" in token && typeof token.text === "string" ? token.text : token.raw;
  const underlineMatch = text.match(/^<u>(.*)<\/u>$/isu);

  if (underlineMatch) {
    return <Text underline>{underlineMatch[1]}</Text>;
  }

  return text.replace(/<[^>]*>/gu, "");
}

function ChatHistory({ runs }: { runs: CompletedRun[] }) {
  if (runs.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {runs.map((run) => (
        <Box flexDirection="column" key={run.id} marginBottom={1}>
          {run.message ? <PromptBlock message={run.message} /> : null}
          <Text>
            <Text color="green">* </Text>
            <Text bold>Complete</Text>{" "}
            <Text color="gray">
              openwiki {run.command} - {run.result.model}
            </Text>
          </Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {run.log.length > 0 ? (
              run.log.map((item) => <RunLogLine item={item} key={item.id} />)
            ) : (
              <Text color="gray">No assistant output captured.</Text>
            )}
          </Box>
          <Divider />
        </Box>
      ))}
    </Box>
  );
}

function ChatInput({ onSubmit }: { onSubmit: (message: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((inputValue, key) => {
    if (key.return) {
      const message = input.trim();

      if (message.length === 0) {
        setError("Enter a follow-up message.");
        return;
      }

      setError(null);
      setInput("");
      onSubmit(message);
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

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider />
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text>
          <Text color="blue">{">"}</Text>{" "}
          {input.length > 0 ? (
            input
          ) : (
            <Text color="gray">Ask a follow-up...</Text>
          )}
        </Text>
      </Box>
      <Text>
        <Text color="gray">
          enter to send - /exit to quit - cwd {formatCwd(process.cwd())}
        </Text>
      </Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}

function PromptBlock({ message }: { message: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="gray" wrap="wrap">
        {" "}
        <Text color="cyan">{">"}</Text> {message}
      </Text>
    </Box>
  );
}

function Divider() {
  return <Text color="gray">{createDivider()}</Text>;
}

function updateRunningCredentialDiagnostics(
  state: RunState,
  credentialDiagnostics: CredentialDiagnostic[],
  credentialDiagnosticsRef: React.MutableRefObject<
    CredentialDiagnostic[] | undefined
  >,
): RunState {
  credentialDiagnosticsRef.current = credentialDiagnostics;

  return state.status === "running"
    ? {
        ...state,
        credentialDiagnostics,
      }
    : state;
}

function appendRunLogEvent(
  log: RunLogItem[],
  event: OpenWikiRunEvent,
  nextLogId: React.MutableRefObject<number>,
): RunLogItem[] {
  if (event.type === "text" && event.text.length === 0) {
    return log;
  }

  if (event.type === "tool_start") {
    const toolDisplay = createToolDisplay(event);

    return [
      ...log,
      {
        call: toolDisplay.showDetail ? event.call : undefined,
        content: toolDisplay.running,
        doneContent: toolDisplay.done,
        id: nextLogId.current++,
        status: "running",
        toolCallId: event.id,
        toolName: event.name,
        type: "tool",
      },
    ];
  }

  if (event.type === "tool_end") {
    return completeToolLogItem(log, event);
  }

  const nextLog = [...log];
  const content = event.type === "text" ? event.text : event.message;
  const previous = nextLog.at(-1);

  if (event.type === "text" && previous?.type === "text") {
    nextLog[nextLog.length - 1] = {
      ...previous,
      content: `${previous.content}${content}`,
    };
  } else {
    nextLog.push({
      id: nextLogId.current,
      type: event.type,
      content,
    });
    nextLogId.current += 1;
  }

  return nextLog;
}

function completeToolLogItem(
  log: RunLogItem[],
  event: Extract<OpenWikiRunEvent, { type: "tool_end" }>,
): RunLogItem[] {
  const matchingIndex = findLastToolLogItemIndex(log, event.id);

  if (matchingIndex === -1) {
    return log;
  }

  return log.map((item, index) =>
    index === matchingIndex
      ? {
          ...item,
          call: undefined,
          content:
            event.status === "error"
              ? `${item.doneContent ?? item.content} failed`
              : (item.doneContent ?? item.content),
          status: event.status === "error" ? "error" : "done",
        }
      : item,
  );
}

function findLastToolLogItemIndex(
  log: RunLogItem[],
  toolCallId: string,
): number {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const item = log[index];

    if (
      item.type === "tool" &&
      item.status === "running" &&
      item.toolCallId === toolCallId
    ) {
      return index;
    }
  }

  return -1;
}

type ToolDisplay = {
  done: string;
  running: string;
  showDetail: boolean;
};

function createToolDisplay(
  event: Extract<OpenWikiRunEvent, { type: "tool_start" }>,
): ToolDisplay {
  const input = parseToolInput(event.input);
  const variantIndex = pickVariantIndex(
    `${event.id}:${event.name}:${event.call}`,
  );

  switch (event.name) {
    case "read_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Reading ${formatCount(count, "file", "files")}`,
          `Examining ${formatCount(count, "file", "files")}`,
          `Taking a look at ${formatCount(count, "file", "files")}`,
        ],
        [
          `Read ${formatCount(count, "file", "files")}`,
          `Examined ${formatCount(count, "file", "files")}`,
          `Looked at ${formatCount(count, "file", "files")}`,
        ],
      );
    }
    case "edit_file": {
      const count = countToolTargets(input, ["path", "paths", "file", "files"]);
      return pickToolDisplay(
        variantIndex,
        [
          `Editing ${formatCount(count, "file", "files")}`,
          `Updating ${formatCount(count, "file", "files")}`,
          `Applying changes to ${formatCount(count, "file", "files")}`,
        ],
        [
          `Edited ${formatCount(count, "file", "files")}`,
          `Updated ${formatCount(count, "file", "files")}`,
          `Applied changes to ${formatCount(count, "file", "files")}`,
        ],
      );
    }
    case "ls":
      return pickToolDisplay(
        variantIndex,
        ["Listing files", "Scanning a directory", "Checking the file tree"],
        ["Listed files", "Scanned a directory", "Checked the file tree"],
      );
    case "glob":
      return pickToolDisplay(
        variantIndex,
        [
          "Finding matching files",
          "Searching file paths",
          "Scanning for matches",
        ],
        ["Found matching files", "Searched file paths", "Scanned for matches"],
      );
    case "grep":
      return pickToolDisplay(
        variantIndex,
        [
          "Searching file contents",
          "Grepping the codebase",
          "Looking for matches",
        ],
        [
          "Searched file contents",
          "Grepped the codebase",
          "Looked for matches",
        ],
      );
    case "write_todos": {
      const count = countTodoItems(input);
      return pickToolDisplay(
        variantIndex,
        [
          `Updating ${formatCount(count, "todo", "todos")}`,
          `Organizing ${formatCount(count, "todo", "todos")}`,
          `Refreshing ${formatCount(count, "todo", "todos")}`,
        ],
        [
          `Updated ${formatCount(count, "todo", "todos")}`,
          `Organized ${formatCount(count, "todo", "todos")}`,
          `Refreshed ${formatCount(count, "todo", "todos")}`,
        ],
      );
    }
    case "task": {
      const count = countToolTargets(input, [
        "tasks",
        "subagents",
        "agents",
        "items",
      ]);
      return pickToolDisplay(
        variantIndex,
        [
          `Spinning up ${formatCount(count, "subagent", "subagents")}`,
          `Starting ${formatCount(count, "subagent", "subagents")}`,
          `Delegating to ${formatCount(count, "subagent", "subagents")}`,
        ],
        [
          `Finished ${formatCount(count, "subagent", "subagents")}`,
          `Completed ${formatCount(count, "subagent", "subagents")}`,
          `Wrapped up ${formatCount(count, "subagent", "subagents")}`,
        ],
      );
    }
    default:
      return {
        done: event.call,
        running: event.call,
        showDetail: false,
      };
  }
}

function pickToolDisplay(
  variantIndex: number,
  running: string[],
  done: string[],
): ToolDisplay {
  const index = variantIndex % Math.min(running.length, done.length);

  return {
    done: done[index],
    running: running[index],
    showDetail: true,
  };
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }

  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function countToolTargets(input: unknown, keys: string[]): number {
  if (Array.isArray(input)) {
    return Math.max(input.length, 1);
  }

  if (!isRecord(input)) {
    return 1;
  }

  for (const key of keys) {
    const value = input[key];

    if (Array.isArray(value)) {
      return Math.max(value.length, 1);
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return 1;
    }
  }

  return 1;
}

function countTodoItems(input: unknown): number {
  if (!isRecord(input)) {
    return 1;
  }

  const todos = input.todos ?? input.items;

  return Array.isArray(todos) ? Math.max(todos.length, 1) : 1;
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function pickVariantIndex(seed: string): number {
  let hash = 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function isExitMessage(message: string): boolean {
  const normalizedMessage = message.trim().toLowerCase();

  return (
    normalizedMessage === "/exit" ||
    normalizedMessage === "exit" ||
    normalizedMessage === "quit"
  );
}

function truncateLogOutput(content: string, label: string): string {
  const terminalColumns = process.stdout.columns ?? 80;
  const availableColumns = Math.max(24, terminalColumns - label.length - 7);

  return truncateToDisplayLines(content, 2, availableColumns);
}

function truncateToDisplayLines(
  content: string,
  maxLines: number,
  maxColumns: number,
): string {
  const normalizedContent = content.replace(/\s+/gu, " ").trim();

  if (normalizedContent.length <= maxColumns) {
    return normalizedContent;
  }

  const lines: string[] = [];
  let remaining = normalizedContent;

  while (remaining.length > 0 && lines.length < maxLines) {
    lines.push(remaining.slice(0, maxColumns));
    remaining = remaining.slice(maxColumns);
  }

  if (remaining.length > 0 && lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    lines[lines.length - 1] =
      lastLine.length > 3 ? `${lastLine.slice(0, -3)}...` : "...";
  }

  return lines.join("\n");
}

function createDivider(): string {
  const terminalColumns = process.stdout.columns ?? 80;

  return "-".repeat(Math.max(24, Math.min(terminalColumns, 120)));
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME;

  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

function isDebugMode(): boolean {
  return process.env.OPENWIKI_DEBUG === "1";
}

function shouldShowCredentialDiagnostics(): boolean {
  return isDebugMode() || process.env.OPENWIKI_DEBUG_CREDENTIALS === "1";
}

async function resolveRunCommand(cwd: string): Promise<OpenWikiCommand> {
  try {
    const directoryStats = await stat(path.join(cwd, OPEN_WIKI_DIR));

    return directoryStats.isDirectory() ? "update" : "init";
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return "init";
    }

    throw error;
  }
}

function parseYesNoAnswer(value: string): boolean | null {
  const answer = value.trim().toLowerCase();

  if (answer.length === 0 || answer === "y" || answer === "yes") {
    return true;
  }

  if (answer === "n" || answer === "no") {
    return false;
  }

  return null;
}

function getErrorDiagnostics(error: unknown): ErrorDiagnostic[] {
  if (!isDebugMode()) {
    return [];
  }

  const diagnostics: ErrorDiagnostic[] = [];

  if (error instanceof Error) {
    diagnostics.push(
      { label: "name", value: error.name },
      { label: "message", value: sanitizeDiagnosticText(error.message) },
    );

    const messageStatus = error.message.match(/\b([45]\d{2})\b/)?.[1];

    if (messageStatus) {
      diagnostics.push({
        label: "httpStatusFromMessage",
        value: messageStatus,
      });
    }
  }

  if (!isRecord(error)) {
    return diagnostics;
  }

  addSafeObjectDiagnostics(diagnostics, error, "");
  addSafeNestedDiagnostics(diagnostics, error, "cause");
  addSafeNestedDiagnostics(diagnostics, error, "error");
  addSafeNestedDiagnostics(diagnostics, error, "response");

  return dedupeDiagnostics(diagnostics);
}

function addSafeNestedDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  key: string,
): void {
  const nested = value[key];

  if (!isRecord(nested)) {
    return;
  }

  addSafeObjectDiagnostics(diagnostics, nested, key);
}

function addSafeObjectDiagnostics(
  diagnostics: ErrorDiagnostic[],
  value: Record<string, unknown>,
  prefix: string,
): void {
  for (const key of [
    "status",
    "statusCode",
    "statusText",
    "code",
    "type",
    "param",
    "request_id",
    "requestID",
    "lc_error_code",
  ]) {
    const property = value[key];

    if (isDiagnosticValue(property)) {
      diagnostics.push({
        label: prefix ? `${prefix}.${key}` : key,
        value: sanitizeDiagnosticText(String(property)),
      });
    }
  }

  addSafeHeaderDiagnostics(diagnostics, value.headers, prefix);
}

function addSafeHeaderDiagnostics(
  diagnostics: ErrorDiagnostic[],
  headers: unknown,
  prefix: string,
): void {
  if (!isRecord(headers)) {
    return;
  }

  for (const key of [
    "x-request-id",
    "request-id",
    "openai-processing-ms",
    "cf-ray",
  ]) {
    const value = getHeaderValue(headers, key);

    if (isDiagnosticValue(value)) {
      diagnostics.push({
        label: prefix ? `${prefix}.header.${key}` : `header.${key}`,
        value: sanitizeDiagnosticText(String(value)),
      });
    }
  }
}

function getHeaderValue(
  headers: Record<string, unknown>,
  key: string,
): unknown {
  if (key in headers) {
    return headers[key];
  }

  const matchingKey = Object.keys(headers).find(
    (headerKey) => headerKey.toLowerCase() === key,
  );

  return matchingKey ? headers[matchingKey] : undefined;
}

function dedupeDiagnostics(diagnostics: ErrorDiagnostic[]): ErrorDiagnostic[] {
  const seen = new Set<string>();
  const deduped: ErrorDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.label}:${diagnostic.value}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(diagnostic);
  }

  return deduped;
}

function isDiagnosticValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function getErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "OpenWiki agent run failed.";

  return sanitizeDiagnosticText(message);
}

function sanitizeDiagnosticText(value: string): string {
  let sanitized = value;

  for (const key of [OPENROUTER_API_KEY_ENV_KEY, "LANGSMITH_API_KEY"]) {
    const secret = process.env[key];

    if (secret && secret.length > 0) {
      sanitized = sanitized.split(secret).join(`[REDACTED:${key}]`);
    }
  }

  return sanitized
    .replace(
      /(Incorrect API key provided:\s*)([^\s.]+)/giu,
      "$1[REDACTED:API_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/gu, "[REDACTED:OPENROUTER_API_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[REDACTED:API_KEY]")
    .replace(/\bls[v_][A-Za-z0-9_-]+/gu, "[REDACTED:LANGSMITH_API_KEY]");
}

function sanitizeHeaderValue(value: string, maxLength = 80): string {
  const compactValue = stripControlCharacters(value)
    .replace(/[^\S\n]+/gu, " ")
    .replace(/[\r\n\t]/gu, " ")
    .trim();

  if (compactValue.length <= maxLength) {
    return compactValue;
  }

  return `${compactValue.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stripControlCharacters(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      sanitized += " ";
      continue;
    }

    sanitized += character;
  }

  return sanitized;
}

type PanelProps = {
  title: string;
  children: React.ReactNode;
};

function Panel({ title, children }: PanelProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan"># </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

type RowsProps = {
  rows: HelpRow[];
};

function Rows({ rows }: RowsProps) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          {"  "}
          {row.label.padEnd(labelWidth)}
          {"  "}
          {row.description}
        </Text>
      ))}
    </>
  );
}

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (parsedCommand.kind === "run" && !parsedCommand.dryRun) {
  await loadOpenWikiEnv();
}

const command = resolveStartupCommand(parsedCommand);

if (argvRequestsPrint(argv) && command.kind === "error") {
  process.stderr.write(`${command.message}\n`);
  process.exitCode = command.exitCode;
} else if (command.kind === "run" && command.print && !command.dryRun) {
  await runPrintCommand(command);
} else {
  render(<App command={command} />);
}

function argvRequestsPrint(argv: string[]): boolean {
  return argv.some((arg) => arg === "-p" || arg === "--print");
}

async function runPrintCommand(
  command: Extract<CliCommand, { kind: "run" }>,
): Promise<void> {
  try {
    const resolvedCommand = await resolveRunCommand(process.cwd());
    const output: string[] = [];

    await runOpenWikiAgent(resolvedCommand, process.cwd(), {
      debug: false,
      modelId: command.modelId,
      userMessage: command.userMessage,
      onEvent: (event) => {
        if (event.type === "text") {
          output.push(event.text);
        }
      },
    });

    const text = output.join("").trim();

    if (text.length > 0) {
      process.stdout.write(`${text}\n`);
    }

    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function resolveStartupCommand(command: CliCommand): CliCommand {
  if (
    command.kind === "run" &&
    !command.dryRun &&
    (command.print || !process.stdin.isTTY)
  ) {
    const hasOpenRouterKey = Boolean(process.env[OPENROUTER_API_KEY_ENV_KEY]);

    if (!hasOpenRouterKey) {
      return {
        kind: "error",
        exitCode: 1,
        message: `${OPENROUTER_API_KEY_ENV_KEY} is required for non-interactive runs. Run openwiki in an interactive terminal to save credentials.`,
      };
    }
  }

  if (
    command.kind === "run" &&
    !command.dryRun &&
    command.userMessage !== null &&
    command.userMessage.trim().length === 0
  ) {
    return {
      kind: "error",
      exitCode: 1,
      message: "User message cannot be empty.",
    };
  }

  return command;
}
