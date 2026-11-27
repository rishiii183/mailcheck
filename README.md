# MailCheck Self-Hosted Cold-Email & Deliverability Platform

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org/)
[![Fastify](https://img.shields.io/badge/fastify-v5.12-black.svg?style=flat-square)](https://fastify.dev/)
[![SQLite](https://img.shields.io/badge/sqlite-WAL%20Mode-blue.svg?style=flat-square)](https://www.sqlite.org/)
[![Tests](https://img.shields.io/badge/tests-67%2F67%20passing-success.svg?style=flat-square)](https://nodejs.org/api/test.html)
[![License](https://img.shields.io/badge/license-MIT-purple.svg?style=flat-square)](LICENSE)
[![Zero Build Step](https://img.shields.io/badge/frontend-Zero%20Build%20Step-orange.svg?style=flat-square)](#frontend--design-mode-godly-mode)

**MailCheck** is an engineer-first, sovereign cold-email outreach, mailbox warm-up, and deliverability verification platform designed to run locally on your own machine. 

Built with **Node.js 20+ ESM**, **Fastify**, and **better-sqlite3** in WAL mode, MailCheck eliminates third-party SaaS subscription costs, privacy compromises, and rate limits. It provides four deeply unified modules backed by a single high-performance SQLite database:

1. **Email Verification Engine** — 9-stage RFC 5322 syntax, domain typo detection, disposable blacklists, role accounts, parallel DNS MX/A/AAAA lookups, raw port 25 SMTP handshake, 24-hour catch-all caching, greylisting settlement, and privacy-masking provider handling.
2. **Campaign Sequencing & Sending** — Multi-step sequences with delay intervals, conditional `"send only if no reply"` logic, A/B subject variants, fallback variable substitution, nested spintax rendering, RFC 2822 `In-Reply-To`/`References` threading, atomic transaction double-send guards, and strict CAN-SPAM physical address compliance.
3. **Engagement Tracking & Analytics** — Isolated tracking engine with 128-bit hex tokens, 1x1 transparent GIF open pixel, machine/bot-open filtering (Apple MPP & GoogleImageProxy), click redirecting, RFC 8058 one-click unsubscribe, IMAP reply listening with sentiment labeling, and RFC 3464 DSN bounce classification.
4. **Peer-to-Peer Mailbox Warm-up Pool** — Autonomous warm-up exchange between your connected accounts, AES-256-GCM credential encryption at rest, automated DNS health monitoring (SPF, DKIM, DMARC, MX), 210 pre-bundled business templates, IMAP spam rescue, simulated conversational reply threads, and rolling 7-day inbox placement health scoring.

---

## Table of Contents

- [Architecture & Two-Server Design](#architecture--two-server-design)
  - [1. Admin Server (Internal Loopback)](#1-admin-server-1270013000)
  - [2. Public Tracking Server (Tunneled Gateway)](#2-public-tracking-server-00003001)
  - [Security & Network Isolation](#security--network-isolation)
- [Frontend & Design Mode (Godly Mode)](#frontend--design-mode-godly-mode)
- [Technical Stack](#technical-stack)
- [Directory Structure](#directory-structure)
- [Quickstart & Installation](#quickstart--installation)
  - [1. Prerequisites](#1-prerequisites)
  - [2. Clone & Install](#2-clone--install)
  - [3. Configure Environment](#3-configure-environment)
  - [4. Seed Disposable Blacklist](#4-seed-disposable-blacklist)
  - [5. Start the Platform](#5-start-the-platform)
- [Tunnel & Reverse Proxy Setup](#tunnel--reverse-proxy-setup)
  - [Option A: Cloudflare Tunnel (Recommended)](#option-a-cloudflare-tunnel-recommended)
  - [Option B: ngrok](#option-b-ngrok)
- [Outbound Port 25 Diagnostics](#outbound-port-25-diagnostics)
- [Deep Dive: The 4 Core Modules](#deep-dive-the-4-core-modules)
  - [Module 1: Email Verification Pipeline](#module-1-email-verification-pipeline)
  - [Module 2: Campaign Sequencing & Sending Engine](#module-2-campaign-sequencing--sending-engine)
  - [Module 3: Tracking & Analytics Dashboard](#module-3-tracking--analytics-dashboard)
  - [Module 4: Autonomous Mailbox Warm-up](#module-4-autonomous-mailbox-warm-up)
- [Complete REST API Reference](#complete-rest-api-reference)
  - [Admin Server APIs (`127.0.0.1:3000`)](#admin-server-apis-1270013000)
  - [Public Server APIs (`0.0.0.0:3001`)](#public-server-apis-00003001)
- [Database Schema & SQLite Architecture](#database-schema--sqlite-architecture)
- [Testing & Quality Assurance](#testing--quality-assurance)
- [Operational Caveats (What Cannot Be Tested In Mock)](#operational-caveats-what-cannot-be-tested-in-mock)
- [License](#license)

---

## Architecture & Two-Server Design

To protect administrative controls, lead data, and database integrity while allowing recipients across the global internet to reach tracking links, MailCheck enforces a strict two-server network isolation model:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                 MailCheck Host                              │
│                                                                             │
│  ┌─────────────────────────────────┐   ┌─────────────────────────────────┐  │
│  │       ADMIN SERVER              │   │       PUBLIC SERVER             │  │
│  │   Binds: 127.0.0.1:3000         │   │   Binds: 0.0.0.0:3001           │  │
│  │   Loopback Only / Private       │   │   Publicly Exposed via Tunnel   │  │
│  ├─────────────────────────────────┤   ├─────────────────────────────────┤  │
│  │ • Fastify Admin Dashboard UI    │   │ • GET  /t/o/:token.gif (Pixel)  │  │
│  │ • REST APIs (/api/*)            │   │ • GET  /t/c/:token (Redirect)   │  │
│  │ • Campaign Scheduler & Worker   │   │ • GET  /u/:token (Unsub Page)   │  │
│  │ • IMAP Reply & Bounce Poller    │   │ • POST /u/:token (RFC 8058)     │  │
│  │ • Optional API_KEY Protection   │   │ • STRICT 404 on all other paths │  │
│  └────────────────┬────────────────┘   └────────────────┬────────────────┘  │
│                   │                                     │                   │
│                   └──────────────┐       ┌──────────────┘                   │
│                                  ▼       ▼                                  │
│                      ┌───────────────────────┐                              │
│                      │   better-sqlite3      │                              │
│                      │   WAL Mode Database   │                              │
│                      │   (mailcheck.db)      │                              │
│                      └───────────────────────┘                              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ Port 3001 Only
                                       ▼
                       ┌───────────────────────────────┐
                       │   Secure Reverse Proxy/Tunnel │
                       │  (Cloudflare Tunnel / ngrok)  │
                       └───────────────┬───────────────┘
                                       │ HTTPS
                                       ▼
                             Recipients on Internet
```

### 1. Admin Server (`127.0.0.1:3000`)
- **Network Interface**: Strictly bound to `127.0.0.1` (localhost loopback). Cannot be accessed from external networks.
- **Role**: Serves the administrative web dashboard, handles bulk lead imports, campaign setup, mailbox CRUD, system diagnostic banners, and real-time SSE progress streams.
- **Authentication**: Optional Bearer token or `x-api-key` header authentication via `API_KEY` in `.env`.
- **Background Tasks**: Houses the 30-second interval sending scheduler loop and IMAP polling listeners.

### 2. Public Tracking Server (`0.0.0.0:3001`)
- **Network Interface**: Binds to `0.0.0.0:3001` so it can be mapped to a Cloudflare Tunnel, ngrok, or reverse proxy.
- **Restricted Surface**: Exposes **strictly four routes**:
  - `GET /t/o/:token.gif` — 42-byte 1x1 transparent GIF with bot-filtering heuristics.
  - `GET /t/c/:token` — 302 redirect to original destination URLs.
  - `GET /u/:token` — Unsubscribe confirmation landing page.
  - `POST /u/:token` — RFC 8058 one-click unsubscribe endpoint for native mail clients.
- **Route Isolation**: Any request to `/`, `/api/*`, `/verifier.html`, or static assets on port 3001 immediately yields a `404 Not Found`.

### Security & Network Isolation
- **Loopback Enforcement**: Administrative operations are never exposed to the public internet.
- **Encrypted Credentials**: SMTP and IMAP passwords are encrypted at rest using AES-256-GCM before entering SQLite.
- **SQL Injection Prevention**: 100% of database queries use parameterized `?` placeholders with zero string concatenation.
- **IP Privacy**: Tracking hits store SHA-256 salted hashes of visitor IP addresses rather than raw IP addresses.

---

## Frontend & Design Mode (Godly Mode)

MailCheck features an award-winning user experience crafted under the **Design Mode (Godly Mode)** aesthetic standards:

- **Obsidian Dark Canvas**: Deep ink-slate base (`#07090e`, `#090c14`) layered with multi-stop ambient radial aurora blooms (`rgba(30, 58, 138, 0.15)` and `rgba(139, 92, 246, 0.06)`).
- **Hairline Glassmorphic Borders**: Translucent glass borders (`rgba(255, 255, 255, 0.08)`) with subtle spotlight glow on hover.
- **Editorial Typography**: Tight display headlines rendered in **Plus Jakarta Sans** (`-0.035em` letter spacing) paired with **JetBrains Mono** for raw SMTP handshakes, tokens, and code previews.
- **Aceternity & Magic UI Touches**:
  - **Animated Border Beam**: Traveling gradient light beam around the verification score card.
  - **Pulsing Radial Brand Halo**: Rhythmic multi-layer glow around the application brand dot.
  - **Calibrated Luxury Badges**: Ambient glowing pill chips for Deliverable (Emerald `#10b981`), Risky (Amber `#f59e0b`), and Undeliverable (Coral `#ef4444`).
- **60fps Fluidity**: All micro-interactions (card lifts, buttons, drawers) execute strictly on the compositor thread using `transform: translateZ(0)` and `opacity` with zero layout thrashing.
- **Zero Build Step**: Static HTML, CSS, and vanilla JS served directly by Fastify with offline vendored Chart.js.

---

## Technical Stack

| Component | Technology | Description |
|---|---|---|
| **Runtime** | Node.js 20+ | Native ECMAScript Modules (ESM) |
| **Server Framework** | Fastify v5 | High-throughput HTTP servers (`@fastify/static`, `@fastify/multipart`) |
| **Database** | SQLite via `better-sqlite3` | Zero-configuration embedded DB running in **WAL mode** |
| **Sending Protocol** | `nodemailer` | Connection pooling and authenticated SMTP delivery |
| **Reading Protocol** | `imapflow` + `mailparser` | IMAP IDLE / polling for replies, spam rescue, and RFC 3464 DSN bounces |
| **Queue & Throttling** | `p-queue` | Global concurrency and per-host rate limiting |
| **Cryptography** | Node.js `crypto` | AES-256-GCM credential encryption, 128-bit tokens, SHA-256 IP hashing |
| **Visualization** | Chart.js (Vendored) | Offline interactive time-series engagement charts |
| **Test Runner** | `node:test` | Native test runner and `node:assert/strict` (67 tests, 0 dependencies) |

---

## Directory Structure

```
mailcheck/
├── src/
│   ├── admin.js                 # Admin Fastify server (127.0.0.1:3000)
│   ├── public.js                # Public tracking server (0.0.0.0:3001)
│   ├── config.js                # Environment & runtime configuration
│   ├── db.js                    # SQLite schema, WAL mode, pragmas & default settings
│   ├── crypto.js                # AES-256-GCM encryption, token generation & IP hashing
│   ├── queue.js                 # Global concurrency & per-host rate-limiting queues
│   ├── verifier/                # Module 1: Email Verification Pipeline
│   │   ├── syntax.js            # RFC 5322 syntax validator
│   │   ├── typo.js              # Levenshtein distance typo detector
│   │   ├── disposable.js        # Disposable domain set matcher
│   │   ├── role.js              # Role-based prefix classifier
│   │   ├── mx.js                # DNS MX & parallel A/AAAA resolver with cache
│   │   ├── smtp.js              # Raw TCP port 25 SMTP probe & port 25 detector
│   │   ├── catchall.js          # Random-address catch-all probe & 24h cache
│   │   ├── score.js             # Penalty-based 0-100 scoring & verdict calculator
│   │   └── index.js             # 9-step pipeline runner & bulk SSE batch processor
│   ├── mailboxes/               # Module 4: Mailbox Management
│   │   ├── accounts.js          # Mailbox CRUD, credential encryption & live testing
│   │   ├── dns-check.js         # SPF, DKIM (9 selectors), DMARC & MX health checker
│   │   └── limits.js            # Warm-up stage progression & daily cap math
│   ├── campaigns/               # Module 2 & 3: Campaigns, Rendering & Tracking
│   │   ├── sequence.js          # Campaign CRUD, sequence steps, variants & launch guards
│   │   ├── render.js            # Variable interpolation, nested spintax & link rewriter
│   │   ├── tracking.js          # Token generator & RFC 8058 header builder
│   │   ├── engine.js            # 30s scheduler loop & atomic claim transactions
│   │   ├── replies.js           # IMAP reply monitor, sentiment analysis & thread stopper
│   │   ├── bounces.js           # RFC 3464 DSN bounce parser & classifier (hard vs soft)
│   │   └── suppression.js       # Global suppression list management
│   ├── warmup/                  # Module 4: Autonomous Mailbox Warm-up
│   │   ├── content.js           # 210 distinct business spintax templates
│   │   ├── planner.js           # Linear ramp-up math & randomized day schedule
│   │   ├── runner.js            # Peer-to-peer sender & IMAP spam folder rescuer
│   │   └── health.js            # Rolling 7-day inbox placement rate & auto-pause rules
│   └── stats/                   # Analytical Single Source of Truth
│       └── queries.js           # Centralized aggregation formulas & funnel metrics
├── public/                      # Static Dashboard UI Assets
│   ├── index.html               # Analytics Overview & KPI dashboard
│   ├── verifier.html            # Email verifier (single + bulk SSE + CSV export)
│   ├── campaigns.html           # Campaign creator & list
│   ├── campaign-detail.html     # Funnel visualizer, variants & lead timeline
│   ├── mailboxes.html           # Mailbox manager & DNS health cards
│   ├── replies.html             # Replies inbox with sentiment tagger
│   ├── suppression.html         # Global suppression list
│   ├── settings.html            # System settings & port 25 diagnostics
│   ├── css/style.css            # Godly luxury dark mode CSS design system
│   └── vendor/chart.js          # Vendored offline Chart.js
├── data/
│   └── disposable.txt           # 300+ disposable domain blacklist
├── scripts/
│   └── update-disposable.js     # Script to pull latest disposable domain lists
├── test/                        # Complete automated test suite (67 tests)
│   ├── db.test.js
│   ├── verifier.test.js
│   ├── mailboxes.test.js
│   ├── campaigns.test.js
│   ├── tracking.test.js
│   ├── replies_bounces.test.js
│   ├── stats.test.js
│   ├── warmup.test.js
│   └── integration.test.js
├── package.json
└── README.md
```

---

## Quickstart & Installation

### 1. Prerequisites
- **Node.js**: `v20.0.0` or higher (tested on Node v24).
- **Operating System**: Windows, macOS, or Linux.
- **Port Availability**: Port 3000 (Admin) and Port 3001 (Public).

### 2. Clone & Install
```bash
git clone https://github.com/rishiii183/mailcheck.git
cd mailcheck
npm install
```

### 3. Configure Environment
Create a `.env` file in the project root:
```ini
# Server Ports
ADMIN_PORT=3000
PUBLIC_PORT=3001

# Public URL exposed via Tunnel/ngrok (Used for tracking & unsubscribe links)
PUBLIC_BASE_URL=https://track.yourdomain.com

# 32-byte hexadecimal encryption key for AES-256-GCM mailbox credentials (64 hex characters)
# Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# Mandatory Admin API Key protection (leave blank to auto-generate into data/.admin_key)
API_KEY=

# Database file location
DB_PATH=mailcheck.db

# Queue & Concurrency Limits
MAX_GLOBAL_CONCURRENCY=10
RATE_LIMIT_PER_HOST_MS=1500
```

> [!TIP]
> Generate a fresh 32-byte hex encryption key anytime using:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 4. Seed Disposable Blacklist
Populate the local disposable email list:
```bash
npm run update-disposable
```

### 5. Start the Platform
Start both servers in separate terminal sessions or background daemons:

```bash
# Terminal 1: Start Admin Dashboard (Internal: http://127.0.0.1:3000)
npm start

# Terminal 2: Start Public Tracking Server (Public: http://0.0.0.0:3001)
npm run public
```

Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)** in your browser to access the dashboard.

---

## Tunnel & Reverse Proxy Setup

Email recipients must be able to load open tracking pixels, click links, and trigger one-click unsubscribes. Because your machine sits behind a NAT/router, you expose **only port 3001** to the public internet.

### Option A: Cloudflare Tunnel (Recommended)
1. Install `cloudflared` from [Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/).
2. Run a tunnel pointing to port 3001:
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```
3. Copy your assigned HTTPS hostname (e.g., `https://my-tunnel-name.trycloudflare.com` or custom domain).
4. Update `PUBLIC_BASE_URL` in your `.env` or in the **Settings** tab in the dashboard.

### Option B: ngrok
1. Run ngrok targeting port 3001:
   ```bash
   ngrok http 3001
   ```
2. Copy the forwarding URL (e.g., `https://xxxx.ngrok-free.app`).
3. Set `PUBLIC_BASE_URL` in `.env` or in the **Settings** page.

> [!CAUTION]
> **Never tunnel port 3000!** Port 3000 is your private control center containing full database access and administrative controls. Only port 3001 is built for public internet ingress.

---

## Outbound Port 25 Diagnostics

During Module 1 verification, MailCheck attempts to probe destination mail servers via raw TCP port 25 without sending data. Many residential ISPs and cloud providers block outbound port 25 to mitigate spam.

- **Automatic Startup Probe**: At boot, MailCheck tests connectivity against `aspmx.l.google.com:25`.
- **Graceful Fallback**: If outbound port 25 is blocked:
  - An amber diagnostic banner appears on the dashboard.
  - The verifier skips raw socket connections to avoid hanging.
  - A real penalty-based quality score is calculated from the remaining checks (syntax, typo, disposable, role, and MX). Clean addresses receive **70/100 (`risky`)** rather than failing or timing out.
  - Cached catch-all domains receive **50/100 (`risky`)**, matching commercial tools.
- **Unblocking**: If deploying on a cloud VPS (e.g. Hetzner, DigitalOcean, Linode), open a support ticket to unblock outbound port 25 for full live SMTP probing.

---

## Deep Dive: The 4 Core Modules

### Module 1: Email Verification Pipeline

The verification engine executes an ordered 9-step pipeline that stops early on hard failures:

```
[Raw Email] ──► 1. RFC 5322 Syntax ──► 2. Typo Detection ──► 3. Disposable Check
                     │ (Hard Fail)                                │ (Hard Fail)
                     ▼                                            ▼
               [Undeliverable]                              [Undeliverable]
                     │
                     ▼
             4. Role Account Check ──► 5. DNS MX / A-Record Lookup
                                              │ (Dead Domain Fail)
                                              ▼
                                        [Undeliverable]
                                              │
                                              ▼
             6. Port 25 Outbound Check ──► 7. SMTP Handshake Probe (Port 25)
                (If Blocked: Fallback)          - EHLO
                                                - MAIL FROM:<verify@...>
                                                - RCPT TO:<target>
                                                - RCPT TO:<random_catchall>
                                                - QUIT (Never sends DATA)
                                              │
                                              ▼
                                         8. Greylisting Handling (4xx)
                                              │
                                              ▼
                                         9. Provider Privacy Masking
                                            (Outlook/Yahoo/iCloud 250 -> Risky)
                                              │
                                              ▼
                                    [Quality Score 0-100 & Verdict]
```

#### Scoring Penalties Matrix
| Check | Penalty Points | Verdict Impact |
|---|---|---|
| **Invalid Syntax** | -100 | Immediate `undeliverable` (Score: 0) |
| **Disposable Domain** | -100 | Immediate `undeliverable` (Score: 0) |
| **Dead Domain (No MX/A)** | -100 | Immediate `undeliverable` (Score: 0) |
| **5xx SMTP Mailbox Reject** | -100 | Immediate `undeliverable` (Score: 0) |
| **Domain Typo Detected** | -30 | Marked `risky` |
| **Unconfirmed SMTP (Port 25 Blocked)** | -30 | Marked `unknown` or `risky` |
| **Greylisted (4xx)** | -25 | Marked `risky` (queue retry) |
| **Catch-All Domain** | -20 | Marked `risky` |
| **A/AAAA Fallback (No MX)** | -20 | Marked `risky` |
| **Role Account (`info@`, `admin@`)** | -15 | Quality reduction |
| **Privacy Masking Provider** | -15 | Marked `risky` (accepts all RCPTs) |

- **Bulk Verification with SSE**: Upload a CSV/TXT list or paste hundreds of emails. Verification runs concurrently in configurable batches of 8 (`BULK_CONCURRENCY`), deduplicating inputs and streaming progress via Server-Sent Events.

---

### Module 2: Campaign Sequencing & Sending Engine

- **Lead Ingestion & Quality Gate**: Leads are scrubbed during import. The engine defaults to `deliverable_only` mode, refusing to send emails to `undeliverable` or `unknown` addresses.
- **Multi-Step Sequences**: Construct multi-stage campaigns with configurable delays in days and `"send only if no reply"` conditions.
- **RFC 2822 Threading**: Follow-up sequence steps set `In-Reply-To` and `References` headers matching the initial email's `Message-ID`, automatically prepending `"Re:"` to ensure messages thread properly in Gmail and Outlook.
- **Template Variables & Fallbacks**:
  - `{{first_name|there}}` -> Uses lead's first name, or "there" if blank.
  - `{{company|your team}}` -> Uses company name, or "your team".
  - `{{custom.role|colleague}}` -> Accesses custom fields from CSV import.
- **Nested Spintax Engine**: Supports deep combinatorial variations:
  - `{Hi|Hello|Hey {there|friend}}, {hope your week is going well|wanted to reach out}`.
- **A/B Variant Testing**: Sequence steps support multiple subject line variants with equal rotation and variant-level conversion tracking.
- **CAN-SPAM & Compliance Rules**:
  - Refuses to launch any campaign if the physical postal address is empty in Settings.
  - Injects sender postal address into the footer of all outgoing HTML emails.
  - Generates RFC 8058 `List-Unsubscribe` (`mailto:` and `https:`) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
- **Atomic Double-Send Protection**: Uses an immediate SQLite transaction claim (`UPDATE lead_steps SET status = 'claimed' ...`) so that application restarts, crashes, or server reboots never result in duplicate sends.

---

### Module 3: Tracking & Analytics Dashboard

- **Open Tracking**: Injects a 1x1 transparent GIF with a unique 128-bit hex token.
- **Bot Open Filtering**: Detects automated scanners and privacy proxies:
  - Apple Mail Privacy Protection (AMPP) user-agent patterns.
  - GoogleImageProxy automated prefetch.
  - Hits occurring within 5 seconds of dispatch.
  - Reports **Unique Opens** and **Likely Real Opens** separately.
- **Click Tracking**: Automatically rewrites HTML links through `/t/c/:token` while leaving unsubscribe and `mailto:` links untouched.
- **IMAP Reply Listener**: Continuously monitors connected mailboxes via IMAP IDLE (falling back to 2-minute polling), detects RFC 3834 auto-replies, and automatically halts future sequence steps upon receiving authentic human replies.
- **Reply Sentiment Tagging**: Replies inbox allows labeling incoming responses as **Interested**, **Not Interested**, or **Neutral**.
- **RFC 3464 DSN Bounce Handling**: Parses `multipart/report` delivery status notifications, distinguishes hard (5.x.x) vs soft (4.x.x) bounces, marks leads bounced, and automatically suppresses them.

---

### Module 4: Autonomous Mailbox Warm-up

- **Closed Peer-to-Peer Pool**: Connected mailboxes exchange realistic business emails with each other. Requires a minimum of 2 connected mailboxes (3+ recommended).
- **DNS Health Checks**: Daily and on-add automated DNS inspection:
  - **SPF**: Verifies TXT record and checks qualifiers (`~all`, `-all`).
  - **DKIM**: Inspects 9 common selectors (`default`, `google`, `k1`, `s1`, `s2`, `mail`, `selector1`, `smtp`, `dkim`).
  - **DMARC**: Verifies policy existence (`p=none`, `p=quarantine`, `p=reject`).
  - **MX**: Confirms mail exchange record availability.
  - Prevents campaign sending if SPF or DKIM fails.
- **Linear Ramp-up Schedule**:
  - Day 1: 3 emails/day.
  - Day 2+: +2 emails/day up to a 40/day cap.
  - Maintenance: Stabilizes at ~15 emails/day.
- **Automated Spam Rescue**: Partner mailboxes check their Spam/Junk folder via IMAP. If a warm-up email landed in Spam, it is moved to the Inbox, marked as read, and starred, logging a `spam_rescued` event.
- **Threaded Conversational Depth**: Partner mailboxes automatically reply to ~35% of messages in the same thread with realistic delays (5m to 6h), producing natural 2–3 message deep threads.
- **Warmup-Linked Campaign Caps**: Protects new mailboxes by automatically throttling campaign send allowances:
  - Days 1–7: 0 campaign sends (100% warm-up focus).
  - Week 2: Max 10 campaign sends/day.
  - Week 3: Max 25 campaign sends/day.
  - Week 4+: Full configured daily cap.
- **Rolling Health & Auto-Pause**: Computes a 7-day inbox placement rate. Automatically pauses warm-up and campaign sends if placement drops below 70% or if >=3 bounces occur.

---

## Complete REST API Reference

### Admin Server APIs (`127.0.0.1:3000`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/system/status` | System health, port 25 availability, tunnel status, postal address compliance |
| `GET` | `/api/settings` | Read all system configuration settings |
| `POST` | `/api/settings` | Update system configuration settings |
| `POST` | `/api/verify` | Verify a single email address through the 9-step pipeline |
| `POST` | `/api/verify/bulk` | Verify a bulk list of emails in concurrent batches |
| `GET` | `/api/verify/bulk/progress` | Server-Sent Events (SSE) stream for bulk verification progress |
| `GET` | `/api/lists` | List all lead lists with lead counts |
| `POST` | `/api/lists` | Create a new lead list |
| `GET` | `/api/lists/:id/leads` | Get leads belonging to a list |
| `POST` | `/api/lists/:id/leads/csv` | Upload CSV file to import and verify leads |
| `GET` | `/api/campaigns` | List all campaigns with aggregate stats |
| `POST` | `/api/campaigns` | Create a new campaign with steps and variants |
| `GET` | `/api/campaigns/:id` | Get campaign details, sequence steps, variants, and assigned mailboxes |
| `POST` | `/api/campaigns/:id/launch` | Launch or resume a campaign (enforces postal address check) |
| `POST` | `/api/campaigns/:id/pause` | Pause an active campaign |
| `POST` | `/api/campaigns/:id/preview` | Preview rendered spintax and variables for a step |
| `GET` | `/api/mailboxes` | List all mailboxes with latest DNS status and daily caps |
| `POST` | `/api/mailboxes` | Add a new mailbox (tests SMTP/IMAP and encrypts passwords) |
| `POST` | `/api/mailboxes/test` | Test SMTP/IMAP credentials without saving |
| `POST` | `/api/mailboxes/:id/dns` | Trigger manual DNS health check |
| `GET` | `/api/mailboxes/:id/health` | Get 7-day warm-up health, placement rate, and reputation score |
| `GET` | `/api/replies` | Get incoming replies across all campaigns |
| `POST` | `/api/replies/:id/label` | Set reply sentiment label (`interested`, `not_interested`, `neutral`) |
| `POST` | `/api/replies/:id/handled` | Mark reply handled or unhandled |
| `GET` | `/api/suppression` | Get paginated global suppression list |
| `POST` | `/api/suppression` | Add single email to suppression list |
| `POST` | `/api/suppression/import` | Bulk import emails to suppression list |
| `DELETE` | `/api/suppression/:email` | Remove email from suppression list |
| `GET` | `/api/stats/overview` | Global KPIs, open rates, bot counts, and 30-day timeline |
| `GET` | `/api/stats/campaigns/:id` | Campaign conversion funnel, variant stats, and mailbox breakdown |
| `GET` | `/api/stats/campaigns/:id/leads` | Filter campaign leads (`opened_no_reply`, `never_opened`, `replied`, etc.) |
| `GET` | `/api/stats/leads/:id/timeline` | Complete event timeline for an individual lead |

### Public Server APIs (`0.0.0.0:3001`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/t/o/:token.gif` | Serves 1x1 GIF open tracking pixel; logs IP hash, user-agent, and bot flags |
| `GET` | `/t/c/:token` | 302 redirect for tracked links; logs click event |
| `GET` | `/u/:token` | HTML landing page confirming recipient has been unsubscribed |
| `POST` | `/u/:token` | RFC 8058 compliant one-click unsubscribe endpoint for native mail clients |

---

## Database Schema & SQLite Architecture

MailCheck utilizes SQLite via `better-sqlite3` configured with high-performance pragmas:
```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

### Relational Tables
1. `settings` — Key-value store for global compliance and network configurations.
2. `mailboxes` — SMTP/IMAP accounts with AES-256-GCM encrypted credentials.
3. `mailbox_dns_checks` — Historical SPF, DKIM, DMARC, and MX validation records.
4. `warmup_plans` — Daily planned send targets per mailbox.
5. `warmup_events` — Sent, received, spam rescued, and replied warm-up exchanges.
6. `lists` — Contact list containers.
7. `leads` — Recipients with JSON custom fields and active/unsubscribed/bounced status.
8. `verification_results` — Email verification cache with detailed check transcripts.
9. `domain_cache` — 24-hour domain-level catch-all and MX provider cache.
10. `campaigns` — Campaigns with schedules, send windows, and sending policies.
11. `campaign_mailboxes` — Many-to-many association between campaigns and sending mailboxes.
12. `sequence_steps` — Ordered sequence steps with delays and conditional rules.
13. `step_variants` — A/B subject line and body variants per sequence step.
14. `lead_steps` — Delivery state machine (`pending`, `claimed`, `sent`, `retrying`, `skipped`).
15. `email_events` — Immutable event log (`sent`, `open`, `click`, `reply`, `bounce_hard`, `unsubscribe`).
16. `tracking_links` — Tokenized registry mapping unique click URLs to destination URLs.
17. `replies` — Inbound replies captured from IMAP with auto-reply tags and sentiment labels.
18. `suppression` — Global blacklist containing unsubscribes, hard bounces, and manual entries.

---

## Testing & Quality Assurance

MailCheck contains a comprehensive, 100% passing automated test suite written for the native Node.js test runner (`node:test`). Tests run in-memory with zero external network dependencies.

Execute the test suite:
```bash
npm test
```

### Test Suite Results (67 Tests, 35 Suites, 100% Passing)
```
✔ Campaigns, Rendering, Sequence & Engine (Step 4) (29ms)
  ✔ Spintax & Variable Rendering (4 tests)
  ✔ Campaign Creation & Launch Safety Rules (2 tests)
  ✔ Engine Scheduler & Double-Send Prevention (2 tests)
✔ Crypto & DB Module (Step 1) (19ms)
  ✔ AES-256-GCM encryption/decryption, tamper detection, tokens, IP hashing, WAL schema (5 tests)
✔ End-to-End Integration Suite (Step 9) (1323ms)
  ✔ Complete lifecycle: Send -> Open -> Click -> Reply -> Bounce -> Stats Verification (1 test)
  ✔ Crash mid-send double-send prevention guarantee (1 test)
  ✔ Warm-up runner against mock environment (1 test)
✔ Mailboxes & DNS Health Module (Step 3) (20ms)
  ✔ Mailbox CRUD & Encrypted Credentials (2 tests)
  ✔ DNS Health Check Logic (SPF, DKIM, DMARC, MX) (2 tests)
  ✔ Sending Limits & Warm-up Ramp Math (2 tests)
✔ Replies, Bounces & Suppression Module (Step 6) (14ms)
  ✔ Auto-Reply Detection & RFC 3834 headers (4 tests)
  ✔ Bounce Classification (5.x.x vs 4.x.x) & DSN Handling (4 tests)
  ✔ Incoming Reply Processing & Sequence Control (2 tests)
✔ Stats Queries & Aggregations (Step 7) (24ms)
  ✔ Rate Calculation Helper & zero-division handling (1 test)
  ✔ Overview Statistics & Bot Separation (1 test)
  ✔ Campaign Detail, Funnels & Segment Filters (3 tests)
✔ Tracking & Public Server (Step 5) (360ms)
  ✔ Bot Open Detection Logic (GoogleImageProxy, fast hits) (3 tests)
  ✔ Open Pixel Route /t/o/:token.gif (1 test)
  ✔ Click Redirect Route /t/c/:token (2 tests)
  ✔ Unsubscribe Route /u/:token (GET & POST RFC 8058) (2 tests)
✔ Email Verifier Pipeline (Step 2) (56ms)
  ✔ Syntax Validation RFC 5322 (2 tests)
  ✔ Typo Detection Levenshtein (2 tests)
  ✔ Disposable Domains (1 test)
  ✔ Role Accounts (1 test)
  ✔ Scoring & Verdict Calculation (4 tests)
  ✔ End-to-End Pipeline & Mock Probing (5 tests)
✔ Warm-up Module (Step 8) (17ms)
  ✔ Ramp-Up Math & Planning (2 tests)
  ✔ Content Repository (210 templates validation) (1 test)
  ✔ Pool Execution & Runner (2 tests)
  ✔ Health & Reputation Calculations (2 tests)

ℹ tests 67 | suites 35 | pass 67 | fail 0 | cancelled 0 | duration_ms 5358
```

---

## Operational Caveats (What Cannot Be Tested In Mock)

While the automated test suite provides 100% deterministic coverage for all platform logic, certain external real-world factors require physical network access:

1. **Big Tech Port 25 Ingress Filtering**:
   - Automated tests verify the raw TCP handshake using local mock sockets.
   - Live socket probing against Big Tech MX servers (`gmail-smtp-in.l.google.com`, `outlook.com`) requires a network or VPS where outbound port 25 is actively unblocked.
2. **Third-Party Email App Passwords & OAuth**:
   - In-memory mock transports simulate authenticated SMTP submissions.
   - Real-world sending via Google Workspace, Microsoft 365, or Amazon SES requires generating App Passwords or SMTP credentials and enabling IMAP access in your account settings.
3. **Public Reverse Tunnel Ingress**:
   - Fastify test calls simulate tracking hits via `.inject()`.
   - Real email client opens depend on an active Cloudflare Tunnel or ngrok forwarding public traffic to port 3001.
4. **Public DNS Propagation**:
   - Evaluating live SPF, DKIM, and DMARC requires that your domain registrar's DNS records have propagated globally across authoritative nameservers.
5. **Real Consumer Inbox Placement**:
   - MailCheck rescues warm-up emails landing in Spam within your connected pool. Real placement at external consumer domains (Gmail, Yahoo, iCloud) depends on external IP/domain reputation, Google Postmaster Tools, and recipient engagement.

---

## License

This project is released under the **MIT License**. Built from first principles for self-hosted sovereign cold email infrastructure.
