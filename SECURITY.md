# Security Policy

## Supported versions

The project is pre-1.0. Security fixes are applied to the latest published
version only.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report
privately using one of:

- GitHub's [private vulnerability reporting](https://github.com/Javierkaiser/opencode-indexing/security/advisories/new)
  (Security → Advisories → *Report a vulnerability*).
- Email **javierkaiser@gmail.com** with a description and, if possible, a
  minimal reproduction.

You can expect an acknowledgement within a few days. Please include the plugin
version, the OpenCode version, the operating system, and the steps to
reproduce. We will coordinate a disclosure timeline with you and credit you in
the release notes unless you prefer to stay anonymous.

## What this plugin touches

Knowing the trust surface helps scope a report:

- **Configuration**: it reads and writes `~/.config/opencode/indexing.json`
  (and, on Windows, the same path under the user profile). API keys are read
  from the environment or plugin options and are **never** written to that file
  in plain text.
- **Vector stores**: it reads Kilo Code's indexes read-only, and writes to its
  own Qdrant collections (`oc-*`) or embedded LanceDB database.
- **Embedding providers**: it sends chunk text to the configured provider
  (Mistral, OpenAI, Ollama, Gemini, Voyage, OpenRouter or any
  OpenAI-compatible endpoint). Which provider is used is entirely your choice.

Please do not include real API keys, tokens, or private source code in a
report. Redact them.
