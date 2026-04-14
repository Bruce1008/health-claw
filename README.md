# Health Claw

A personal fitness coach skill for [OpenClaw](https://github.com/nicepkg/openclaw), with companion iPhone and Apple Watch apps.

## What It Does

Health Claw turns OpenClaw into a context-aware fitness assistant that lives on your wrist. It connects to Apple HealthKit data (heart rate, HRV, sleep, activity rings) and uses that real-time biometric context to:

- **Assess readiness** — Evaluate your physical state before every workout using multi-dimensional health signals.
- **Plan workouts** — Generate personalized training plans with built-in safety guardrails (fatigue detection, injury awareness, heart rate limits).
- **Coach in real-time** — Drive workout sessions from the Apple Watch with countdowns, set tracking, and mid-session adjustments.
- **Review & report** — Auto-generate post-session reviews, daily/weekly/monthly reports with trend analysis.
- **Detect anomalies** — Proactively alert when health metrics deviate from your baseline.

## Architecture

```
┌──────────────┐    HTTP/WSS     ┌────────────────┐    MCP Tools     ┌──────────┐
│  iPhone App  │ ◄─────────────► │   MCP Server   │ ◄──────────────► │ OpenClaw │
│  Watch App   │                 │  (mcp-server.js)│                  │  Agent   │
└──────────────┘                 └────────────────┘                  └──────────┘
       │                                │
       ▼                                ▼
  Apple HealthKit              Local JSON Storage
  (read-only)                  (state, logs, reports)
```

- **MCP Server** — A Node.js stdio server exposing 21 tools for state management, health logging, workout control, report generation, and cron scheduling. Also serves a local HTTP endpoint for the companion apps.
- **Companion Apps** — Native Swift apps for iPhone and Apple Watch. The Watch app handles real-time workout UI (countdowns, heart rate display, set progression); the iPhone app handles onboarding, reports, and daily check-ins.
- **All data stays on-device.** No cloud sync, no third-party servers. Health data is read from HealthKit and stored locally.

## Skill Scenes

| Scene | Description |
|---|---|
| Onboarding | First-launch questionnaire to establish fitness profile, goals, and injury history |
| Readiness Check | Pre-workout body state assessment using HealthKit metrics |
| Workout Confirm | Training plan generation with safety guardrails |
| During Session | Real-time coaching via Apple Watch (driven locally, callbacks for adjustments) |
| Post Session | Workout review, feedback collection, and recovery recommendations |
| Reports | Daily / weekly / monthly trend reports |
| Anomaly Alert | Proactive notifications when health metrics deviate from baseline |

## Project Structure

```
.
├── SKILL.md                  # Skill execution rules for OpenClaw
├── .mcp.json                 # MCP server configuration
├── scripts/
│   └── mcp-server.js         # MCP server implementation (21 tools)
└── references/
    ├── scene-onboarding.md   # Onboarding flow spec
    ├── scene-readiness.md    # Readiness assessment spec
    ├── scene-workout-confirm.md
    ├── scene-during-session.md
    ├── scene-post-session.md
    ├── scene-reports.md
    ├── scene-anomaly-alert.md
    ├── state-schema.md       # User state JSON schema
    ├── health-log-schema.md  # Health log JSON schema
    └── report-schema.md      # Report JSON schema
```


## License

[MIT License](./LICENSE) © Dang JiaHe
