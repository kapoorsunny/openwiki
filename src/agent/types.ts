export type OpenWikiCommand = "init" | "update";

export type OpenWikiRunResult = {
  command: OpenWikiCommand;
  model: string;
};

export type OpenWikiRunEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_start";
      call: string;
      id: string;
      input: unknown;
      name: string;
    }
  | {
      type: "tool_end";
      id: string;
      name: string;
      status: "error" | "finished";
    }
  | {
      type: "debug";
      message: string;
    };

export type OpenWikiRunOptions = {
  debug?: boolean;
  isFollowup?: boolean;
  modelId?: string | null;
  onEvent?: (event: OpenWikiRunEvent) => void;
  userMessage?: string | null;
};

export type UpdateMetadata = {
  updatedAt: string;
  command: OpenWikiCommand;
  model: string;
};

export type RunContext = {
  lastUpdate: UpdateMetadata | null;
  gitSummary: string;
};
