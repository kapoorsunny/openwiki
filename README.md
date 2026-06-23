# OpenWiki

OpenWiki is a CLI that uses a DeepAgents documentation agent to generate and maintain human- and agent-readable documentation for a codebase.

## Install

```sh
npm install -g openwiki
```

## Usage

```sh
openwiki
openwiki -p "Summarize what you can do"
openwiki --modelId openai/gpt-5.5
openwiki "Please document the API routes first"
```

`openwiki` creates initial documentation in `openwiki/` when no wiki exists. If `openwiki/` already exists, it refreshes that documentation from repository changes. By default, the CLI stays open after each run so you can send follow-up messages. Use `-p` or `--print` for a one-shot non-interactive run that prints the final assistant output.

On the first interactive run, OpenWiki asks for an OpenRouter API key, lets you pick a default model, and saves both to `~/.openwiki/.env`. A LangSmith API key can also be provided optionally.

See `examples/openwiki-update.yml` for a GitHub Actions workflow you can copy into a repository for scheduled updates.
