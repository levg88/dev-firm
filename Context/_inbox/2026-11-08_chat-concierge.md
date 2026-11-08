## [Topic: Firm Agents]

- The Chat page is a tool-calling concierge (`src/chat/agent.ts`, `ChatService`), not a single-shot intent classifier; it carries conversation history and chooses tools per turn. (General)
- Concierge tools cover repository discovery/inspection, firm status, builds/artifacts/tickets, and starting a delivery run. Repository inspection is read-only and path-escape protected (`src/chat/repos.ts`). (General)
- `start_build` resolves a repo, creates a workflow, then hands execution to the normal `BuildService`; the concierge does not run delivery stages itself. (General)
- `Agent.run` accepts prior user/assistant `history` and returns a `toolTrace`; the chat API persists that trace in assistant message metadata. (General)
- The offline mock provider returns a deterministic fallback instead of simulating the concierge. (General)
