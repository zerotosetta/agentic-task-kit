# Local Setup

## Requirements
- Node.js 22+
- npm 10+

## Install
```bash
npm install
```

## Useful commands
```bash
npm run typecheck
npm test
npm run build
npm run example
npm run example:consumer
npm run example:openai
```

## CLI rendering
- live rendering on:
```bash
npm run example
```
- line mode:
```bash
CYCLE_RENDER_MODE=line npm run example
```
- live rendering off:
```bash
CYCLE_LIVE=0 npm run example
```

## OpenAI Chat API example
- required env:
```bash
export OPENAI_API_KEY=your_key_here
```
- run:
```bash
npm run example:openai
```
- optional env:
```bash
export OPENAI_MODEL=gpt-5.2
export OPENAI_TIMEOUT_MS=20000
export OPENAI_MAX_RETRIES=2
```
- OpenAI-compatible streaming:
```bash
OPENAI_API_KEY=your_key_here CYCLE_STREAM=1 npm run example:openai
```
- request-scoped headers:
```bash
OPENAI_API_KEY=your_key_here \
CYCLE_REQUEST_HEADERS_JSON='{"X-Request-ID":"local-example"}' \
npm run example:openai
```
- HTTP debug logging:
```bash
OPENAI_API_KEY=your_key_here OPENAI_HTTP_DEBUG=1 npm run example:openai
```

## Sample project
repo root example app:
```bash
cd sample-project
npm install
npm run typecheck
OPENAI_API_KEY=your_key_here npm run start
```

config file path override:
```bash
cd sample-project
OPENAI_API_KEY=your_key_here CYCLE_OPENAI_CONFIG_PATH=./cycle.config.json npm run start
```

streaming sample project run:
```bash
cd sample-project
OPENAI_API_KEY=your_key_here CYCLE_STREAM=1 npm run start
```
