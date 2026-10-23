# Paperclip managed runtime

This fork ships a managed ACP profile for Paperclip's native Runner on macOS ARM64. Paperclip selects the exact `provider/model`, stages one authorized account, supplies literal governance instructions, and owns task permissions and lifecycle. The fork acknowledges instruction bytes on session creation and load. Ordinary upstream profiles keep their existing behavior.

ChatGPT subscriptions use the `openai-codex/<model>` route and a selected Paperclip connection. The launcher converts staged Codex OAuth into the native credential store; only token rotations are atomically exported before ACP responses. API routes remain separate. Managed boot ignores workspace/home `.env` files, disables upstream telemetry and auxiliary paid search, and confines filesystem and Bash tools to task roots while protecting credentials and Runner state. Unconfined search, PowerShell and workflow/PTC tools are disabled in this profile.

Build from a clean checkout under Node 24.22.0 with the lockfile installed:

```sh
pnpm install --frozen-lockfile
pnpm run build:native-system
pnpm exec tsx scripts/paperclip/build.ts --output /absolute/new-runtime-directory
node scripts/paperclip/probe.mjs /absolute/new-runtime-directory
```

The output includes its Node interpreter, complete production runtime, licenses, source revision and a SHA256 inventory. The protocol probe uses synthetic credentials and never prompts a model. Paperclip pins the source revision and inventory digest independently; an arbitrary upstream package or modified output is rejected. Follow Paperclip's DeepSeek integration documentation for import and qualification. Publishing this fork or a runtime archive is a separate release action.
