# Agent Instructions for PatchTree
write quality code dont write too many redundant lines of code if a code can be written in 200 lines insetad of 400 lines without increasing the complexity too much write it in 200 lines with accuracy.
## Before marking any task done
1. Run the code yourself (start the server, run the test, run the build) — don't just write it and assume it works.
2. If there's an error, fix it and run it again before reporting back.
3. Never guess a library's function names — check the installed version in package.json / requirements.txt first, or look it up with the docs tool if unsure.
4. Keep changes scoped to what was asked. Don't refactor unrelated files unless told to.
5. If even after a number of repeated tries the error continues, then only give the error and details about it.

## Project context
- Backend: Python + FastAPI
- Frontend: React + Vite + TypeScript
- Database: Supabase (hosted Postgres) — not local Docker Postgres
- AI calls and sandboxing go through Nebius Token Factory + Contree SDK 
- See /docs for full architecture, risks, and build plan before making structural changes