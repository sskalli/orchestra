# Orchestra

A local-first starter monorepo for boards, conversations, and model-backed agent workflows.

## Setup

1. Copy `.env.example` to `.env` and `backend/.env.example` to `backend/.env`; adjust values if needed.
2. Start PostgreSQL with `docker compose up -d db` (start `ollama` too if desired).
3. Install dependencies from the repository root with `npm install`.
4. Create the database schema with `npm run db:push --workspace backend`.
5. Start both applications with `npm run dev`.

The backend runs at `http://localhost:3000`, and the frontend runs at `http://localhost:5173`.

For local model usage, run Ollama separately or start the compose service, pull a model such as `ollama pull llama3.2`, and set `OLLAMA_BASE_URL` as needed. Model streaming is wired through the OpenAI-compatible `/v1/chat/completions` endpoint; the starter UI currently stores messages without triggering a completion automatically.
