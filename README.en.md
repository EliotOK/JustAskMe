# JustAskMe

[中文（默认）](README.md)

JustAskMe provides structured questions through MCP form elicitation, together with
DiscussWithMe, a skill for involving the user in consequential decisions and
returning to execution once the next step is clear.

## Install

Prerequisites: Codex CLI (or Desktop with its CLI available), Node.js >=20.11.0,
Python >=3.10, and Git. Python 3.11+ is needed to inspect multiline TOML configuration.

```powershell
git clone https://github.com/EliotOK/JustAskMe.git
cd JustAskMe
.\Install.cmd
```

On macOS/Linux use `python3 install.py`; this revision's automated validation ran
on Windows, so other platforms still need real-machine acceptance testing.

If an earlier plugin, manual MCP registration, or matching skill conflicts:

```powershell
.\Install.cmd --migrate
```

The installer is self-contained. It stages and checks the packaged server before
registration. It preserves recovery backups under
`$CODEX_HOME/just-ask-me-backups/` (default `~/.codex/just-ask-me-backups/`),
archives matching skills outside discovery directories, and preserves unrelated
marketplace entries. On failure it attempts to restore files and registrations;
any recovery failure is reported with the backup location. Legacy source files
remain available. Existing manual MCP entries in a configuration with multiline
strings require manual migration before running the installer.

Open a new Codex task, call `human_input_status`, and then ask a sample question.
A successful status check reports negotiated capabilities; actually submit a
question to verify the UI.

## Tools and discussion

- `ask_choice`: select an option; with `allow_free_text`, submit a text reply or
  clarification question even without selecting an option.
- `ask_confirm`: submit yes/no.
- `ask_text`: submit text.
- `ask_multi_select`: select a bounded subset.
- `human_input_status`: inspect capabilities and configuration.

A text-only choice reply returns `discussion`, with no selected option. The agent
must interpret the text: answer clarification requests first, or adopt an explicit
written decision. `answered` submissions must also be read together with any text
qualifications. Cancellation, timeout, and missing answers never constitute approval.

Use `$discuss-with-me` to enable discussion during work. The skill asks about
meaningful decisions and proceeds when sufficient information is available.

Native forms depend on client support. `HIM_FALLBACK=return` hands the question
back for chat; `http` enables a temporary browser form; `off` returns an error.
The default server timeout is 300 seconds, but client limits can end a call sooner.
System notifications depend on Codex and OS settings and are not guaranteed.
HTTP validation errors keep the form open so the user can correct their input.

## Validate

```shell
npm ci
npx playwright install chromium
npm run verify
```

This runs TypeScript checks/builds, protocol tests, the packaged server smoke test,
isolated installer tests with a simulated CLI, and real Chromium form tests.
Real Codex installation, native UI, long waits, and notifications still require
host acceptance testing. See [VALIDATION.md](VALIDATION.md) for recorded results.

MIT license. See [LICENSE](LICENSE).
