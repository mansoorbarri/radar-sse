# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Real-time flight tracking SSE server for GeoFS. Broadcasts live aircraft positions and manages flight recording sessions with persistence to Convex backend.

## Commands

```bash
bun install        # Install dependencies
bun run start      # Run server (bun run server.js) - listens on PORT or 3001
bun run lint       # Run ESLint
bun run lint:fix   # Run ESLint with auto-fix
```

## Architecture

**Single-file monolith** - all application logic is in `server.js` (~635 lines).

### Core Data Structures (in-memory)

- `aircraftMap` - Current aircraft positions (Map<id, aircraft_data>)
- `flightSessions` - Active flight recordings (Map<id, session>)
- `disconnectedSessions` - Sessions in 3-minute grace period awaiting reconnection (Map<convexUserId, data>)
- `subscribers` - SSE client connections (Array<{id, res}>)
- `commandQueue` - Pending remote commands per aircraft (Map<id, commands[]>)

### Key Timings

- **Grace period**: 180 seconds before finalizing disconnected flights
- **Timeout check**: Every 5 seconds (removes aircraft silent >12 seconds)
- **Grace finalization**: Every 30 seconds
- **Retry logic**: 3 attempts at 30-second intervals for failed saves

### API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/atc/position` | Ingest aircraft position updates |
| `GET /api/stream` | SSE stream for real-time aircraft data |
| `POST /api/command` | Queue remote commands for aircraft |
| `GET /api/commands/:id` | Fetch pending commands for an aircraft |
| `POST /api/end-flight` | Immediately finalize an active flight |
| `GET /api/failed-flights` | List sessions with save failures |
| `POST /api/retry-flight` | Manual retry for failed session saves |

### Convex Integration

Backend-as-a-service for persistent storage. Key operations:

**Queries:**
- `users:getByGoogleId` - User lookup
- `missingImageNotifications:exists` - Check notification status
- `aircraftImages:getApprovedImage` - Get aircraft image

**Mutations:**
- `flights:create` - Save completed flight with route data
- `missingImageNotifications:create` - Record missing image

**Constraint:** Convex arrays limited to 8,192 elements. Route coordinates are downsampled to 8,000 max.

### Data Normalization

- Aircraft types: "Boeing 777-300ER" → "B777", "Airbus A320" → "A320"
- Airline codes: "UAE123" → "UAE", "EK456" → "EK"

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CONVEX_URL` or `NEXT_PUBLIC_CONVEX_URL` | Yes | Convex backend URL |
| `PORT` | No | Server port (default: 3001) |
| `DISCORD_MISSING_IMAGE_WEBHOOK` | No | Discord webhook for missing image alerts |

## Log Prefixes

Console logs use structured tags: `[AUTH]`, `[NOTIFY]`, `[FINALIZE]`, `[RETRY]`, `[DISCONNECT]`, `[TIMEOUT]`, `[CMD]`, `[END-FLIGHT]`, `[DB ERROR]`
