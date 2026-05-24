# Repository Guidelines

## Project Structure & Module Organization

This is a no-build Azure Static Web Apps MVP. The browser app lives at the repository root: `index.html`, `styles.css`, and `app.js`. Runtime assets are loaded from `assets/`; public syncs keep that directory as a placeholder and do not commit local VRM, VRMA, or audio files. Azure Functions live in `api/`; each endpoint has its own folder with `index.js` and `function.json` (`health`, `realtime-token`, `chat-turn`, `advisor`). Shared API helpers are in `api/_shared/azureOpenAI.js`. Keep configuration samples in `api/local.settings.sample.json`; do not commit real local secrets. Do not use the local Static Web Apps emulator for this project.

## Build, Test, and Development Commands

- `npm install` installs the local smoke-test dependency.
- `cd api && npm start` starts only Azure Functions with `func start`; use this when debugging API endpoints separately.
- `cp api/local.settings.sample.json api/local.settings.json` creates local settings before adding Azure OpenAI values.

There is no bundling step; root frontend modules are loaded directly by the browser through the import map in `index.html`.

## Coding Style & Naming Conventions

Use JavaScript with 2-space indentation and semicolons, matching existing files. Frontend code uses ES modules and `const`/`let`; API Functions use CommonJS and `'use strict'`. Prefer small helper functions in `api/_shared/` when logic is reused across endpoints. Name new Functions by route intent, using kebab-case folders such as `api/realtime-token/`.

## Testing Guidelines

No automated test framework is currently configured. For API-only work, use `cd api && npm start` and call the Functions endpoints directly. For frontend-only checks, open `index.html` locally when the browser security model allows it, or validate against a deployed Static Web Apps environment. If tests are added later, place them near the code or under `tests/`, and add a root `npm test` script.

## Commit & Pull Request Guidelines

This checkout has no Git history, so no existing commit convention can be inferred. Use short imperative commit messages, for example `Add advisor retry handling` or `Update avatar loading state`. Pull requests should describe the user-visible change, list local verification steps, mention any Azure setting changes, and include screenshots or short recordings for UI changes.

## Security & Configuration Tips

Never commit `api/local.settings.json`, Azure OpenAI keys, or endpoint-specific secrets. Keep model deployment names configurable through app settings or the existing UI settings. Recheck current Azure Realtime API fields before changing request payloads because preview and GA schemas can change.

## Azure OpenAI & Microsoft Foundry Documentation

Before changing Azure OpenAI, Realtime, Chat Completions, Responses, model deployment, token limit, or Microsoft Foundry related code, always consult the latest English Microsoft Learn documentation for Microsoft Foundry / Azure OpenAI. Prefer the English docs because Azure OpenAI and Foundry APIs change frequently, localized pages can lag, and Foundry behavior can differ subtly from OpenAI API behavior. Mention the specific docs checked in the final response when such changes are made.

## Realtime Advice Architecture

For normal voice conversation, do not add a separate transcription/STT pass for the human speaker. Do not send chopped user audio or per-turn speech fragments to another transcription model or advisor model as the primary signal; that raises cost, increases 429 risk, and breaks the intended system shape. Treat Azure OpenAI Realtime as the single audio conversation engine. Use Realtime events and the Realtime assistant response transcript (`response.output_audio_transcript.*`) as the primary observable signal for conversation state and advice generation. Only use explicit audio transcription smoke tests as diagnostics, not as the production advice path.
