# ONTIQ ; a background OSINT agent 

<img width="1000" height="563" alt="ontiq-demo" src="https://github.com/user-attachments/assets/9e59db29-7540-46a0-a333-db3c8cc0056d" />

## What it does

You give it an objective only using your voice. It browses public pages, pulls findings, and leaves a provenance trail. You review the brief in a world where you don’t babysit the browser.

**Good for:** brand/threat monitoring, entity research, IOC pivots, due diligence, overnight watches.

**Not for:** researching private systems or credential stuffing

## Quick start

```bash
cd agent-runner
bun install
node src/run.mjs --objective "Public footprint of example.com"
```

Use **Node**, not Bun (Playwright can hang under Bun on Windows).

## Browser backend

1. Steel self-hosted (`STEEL_BASE_URL`)
2. Steel cloud (`STEEL_API_KEY`)
3. Local Playwright Chromium

## Guardrails

Public sources only. Attribute every finding. Human reviews before action. You’re responsible for law and ToS. 
