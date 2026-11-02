# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Support OpenAI Responses, Anthropic Messages, and Gemini generateContent through `createAIProvider()` / JSON configuration.
- Accept native request payloads without common messages; support defaults, explicit replacement, JSON/SSE normalization, raw tool events, and cancellation.

- Require Node.js 22.12 or newer; verify Windows/Linux on Node 22, 24, and 26.
- Upgrade to TypeScript 7, Ink 8, React 19.3, OpenAI SDK 7, and Vitest 5 with Vite 8.
- Replace compiler API tooling with the public TypeScript CLI and esbuild's resolved import graph.
- Remove obsolete abort-signal fallback and duplicate OpenAIChat wrapper implementations while preserving public aliases.
- Upgrade sample dependencies and remove deprecated TypeScript configuration and internal CLI paths.
- Override vulnerable Leflect ZIP/XML dependencies with patched releases and verify TLD/JAR loading in consumer CI.

## v0.1.8 - 2026-04-08

- feat: include changelog in release workflow (#32)

## v0.1.7 - 2026-04-09

- fix: keep full task log meta in line mode (#31)
- feat: exit ink session after workflow cancellation (#30)
- chore: preserve sample task failure details (#29)
