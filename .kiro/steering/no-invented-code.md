---
inclusion: always
---

# No Invented Game Logic

**NEVER invent, approximate, or fabricate game mechanics, physics values, timing arrays, or protocol behavior.**

All game logic must come from one of these sources only:
1. **Decompiled Flash source** (`tmp_ffdec_*` folders) — the authoritative reference for what the client expects
2. **Live capture data** (decoded HTTP responses, TCP captures) — real server behavior
3. **Database/catalog data** — actual game data

## Specific rules

- If a value came from the live server (e.g. a timing array, an `<n2>` attribute), use that exact value. Do not replace it with a computed approximation.
- If a function was not in the original game (e.g. `generateTimingArray`, `generateCarStats`), do not create it. Find the real source.
- If the ffdec shows how the client reads a response, implement the server response to match exactly — no guessing at attribute meanings.
- If unsure what a value should be, check the ffdec scripts first, then the captures. Ask the user if still unclear.
- Do not use fixture files as a crutch — they are reference data only, not a fallback serving mechanism.
- **Exception**: When no real data exists and the user explicitly requests placeholder values, invented values are acceptable as a temporary measure. Mark them clearly with a `// PLACEHOLDER` comment and a note that they need real capture data.
