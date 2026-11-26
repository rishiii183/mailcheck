# MailCheck — Self-Hosted Cold-Email Platform

MailCheck is an engineer-first, self-hosted cold-email and deliverability platform built to run locally on your own machine. It provides four deeply integrated modules that share a single high-performance SQLite database:

1. **Email Verification** — Multi-stage RFC 5322 syntax, typo correction, disposable domain lists, role accounts, MX lookup with A/AAAA fallbacks, raw SMTP port 25 probe, 24h catch-all cache, greylisting settlement, and provider privacy masking (Outlook/Yahoo/iCloud).
2. **Campaign Setup & Sending** — Multi-step sequence campaigns with A/B subject variants, fallback variable interpolation (`{{first_name|there}}`), nested spintax (`{Hi|Hello}`), In-Reply-To/References RFC 2822 threading, send window & daily cap throttling, atomic SQLite transaction double-send protection, and mandatory CAN-SPAM physical address compliance.
3. **Tracking & Analytics Dashboard** — Fastify-powered dashboard and tracking engine with 128-bit random tokens, 1x1 GIF open tracking, machine/bot-open filtering (Apple Mail Privacy Protection & GoogleImageProxy), link rewriting (preserving unsubscribe links), RFC 8058 one-click unsubscribe, IMAP reply listening with sentiment labeling, and RFC 3464 DSN bounce classification.
4. **Mailbox Warm-up Engine** — Automated peer-to-peer warm-up exchange between your connected mailboxes with AES-256-GCM credential encryption at rest, live SPF/DKIM/DMARC/MX health checks, 205+ built-in business spintax templates, automated IMAP spam rescue, simulated human thread replies (35% reply rate), and 7-day rolling health scoring.

---

## Architecture & Two-Server Design

To safeguard dashboard data and admin APIs while remaining accessible to email recipients worldwide, MailCheck runs as two separate Fastify HTTP servers with a strict network boundary:

```
                  +----------------------------------------------+
                  |                 MailCheck                    |
                  |                                              |
                  |  [Admin Server]                              |
                  |  Binds: 127.0.0.1:3000 (Internal Only)       |
                  |  Routes: Dashboard UI, /api/*                |
                  |  Access: Local Machine / API Key Auth        |
                  |                                              |
                  |  [Public Server]                             |
                  |  Binds: 0.0.0.0:3001 (Exposed via Tunnel)    |
                  |  Routes (Strictly Restricted):               |
                  |   - GET  /t/o/:token.gif (Open Pixel)        |
                  |   - GET  /t/c/:token     (Click Redirect)    |
                  |   - GET  /u/:token       (Unsubscribe Page)  |
                  |   - POST /u/:token       (One-Click RFC 8058)|
                  +----------------------------------------------+
                                       ^
                                       |
                                [Reverse Proxy]
                          (Cloudflare Tunnel / ngrok)
                                       ^
                                       |
                             Recipients on Internet
```

### 1. Admin Server (`127.0.0.1:3000`)
- Strictly bound to localhost loopback `127.0.0.1`.
- Serves static dashboard assets (HTML/CSS/JS without build steps).
- Provides REST APIs for campaigns, lead lists, mailboxes, replies, suppression, and stats.
- Optional API key protection via `API_KEY` in `.env`.
- Displays active diagnostic alerts if `PUBLIC_BASE_URL` is unconfigured, if outbound port 25 is blocked, or if a physical postal address is missing.

### 2. Public Tracking Server (`0.0.0.0:3001`)
- Binds to `0.0.0.0:3001` so it can be safely tunneled out via Cloudflare Tunnel or ngrok.
- Exposes **ONLY** the four tracking endpoints:
  - `GET /t/o/:token.gif` — 1x1 transparent GIF open pixel with bot-open heuristics.
  - `GET /t/c/:token` — 302 redirect for tracked links (unsub links are never rewritten).
  - `GET /u/:token` — Unsubscribe confirmation page.
  - `POST /u/:token` — RFC 8058 one-click unsubscribe handler for mail clients.
- Any attempt to reach admin APIs or dashboard routes on port 3001 returns a 404.

---

## Tech Stack

- **Runtime**: Node.js 20+ (Native ESM)
- **Web Framework**: Fastify v4 (`@fastify/static`, `@fastify/multipart`)
- **Database**: SQLite via `better-sqlite3` running in **WAL mode** with foreign key constraints enabled
- **Mail Protocols**:
  - `nodemailer` (SMTP campaign & warmup sending)
  - `imapflow` + `mailparser` (IMAP reply listening, spam folder rescue, DSN bounce processing)
- **Concurrency & Rate Limiting**: `p-queue` (global concurrency + per-host rate limiting)
- **Cryptography**: Node.js native `crypto` (AES-256-GCM for credential encryption, 128-bit random token generation, SHA-256 IP hashing)
- **Frontend**: Vanilla HTML5, modern CSS3 (custom CSS design system), vanilla JS, and vendored Chart.js (zero frontend build steps)
- **Test Framework**: `node:test` + `node:assert/strict`

---

## Directory Structure

```
mailcheck/
├── src/
│   ├── admin.js                 # Admin Fastify server (127.0.0.1:3000)
│   ├── public.js                # Public tracking server (0.0.0.0:3001)
│   ├── config.js                # Environment configuration loader
│   ├── db.js                    # SQLite schema, WAL pragma & settings store
│   ├── crypto.js                # AES-256-GCM encryption & token helpers
│   ├── queue.js                 # Global concurrency & per-host rate limits
│   ├── verifier/                # Module 1: Email Verification
│   │   ├── syntax.js            # RFC 5322 syntax validation
│   │   ├── typo.js              # Levenshtein distance typo suggestions
│   │   ├── disposable.js        # Disposable domains lookup
│   │   ├── role.js              # Role-based account detection
│   │   ├── mx.js                # DNS MX & A/AAAA record resolver
│   │   ├── smtp.js              # Raw port 25 SMTP handshake prober
│   │   ├── catchall.js          # Catch-all mailbox detection & 24h caching
│   │   ├── score.js             # 0-100 score & deliverability verdict logic
│   │   └── index.js             # Verification pipeline & bulk SSE runner
│   ├── mailboxes/               # Module 4: Mailbox Management
│   │   ├── accounts.js          # Mailbox CRUD & credential encryption
│   │   ├── dns-check.js         # SPF, DKIM, DMARC, MX health checker
│   │   └── limits.js            # Warmup stage caps & daily quotas
│   ├── campaigns/               # Module 2 & 3: Campaigns & Tracking
│   │   ├── sequence.js          # Sequences, variants & campaign lifecycle
│   │   ├── render.js            # Spintax, variable replacement & link rewriter
│   │   ├── tracking.js          # Token generator & RFC 8058 header builder
│   │   ├── engine.js            # 30s scheduler loop & atomic claim transactions
│   │   ├── replies.js           # IMAP reply monitor & sentiment analysis
│   │   ├── bounces.js           # RFC 3464 DSN bounce parser & classification
│   │   └── suppression.js       # Global unsubscribe & bounce suppression list
│   ├── warmup/                  # Module 4: Mailbox Warm-up
│   │   ├── content.js           # 205 business spintax templates
│   │   ├── planner.js           # Ramp-up progression math & randomized timing
│   │   ├── runner.js            # Peer-to-peer email sender & IMAP spam rescuer
│   │   └── health.js            # Rolling 7-day inbox placement rate & reputation
│   └── stats/                   # Analytics Single Source of Truth
│       └── queries.js           # Centralized aggregation formulas & funnel metrics
├── public/                      # Dashboard UI Pages & Assets
│   ├── index.html               # Analytics Overview & KPI dashboard
│   ├── verifier.html            # Email verifier (single + bulk SSE)
│   ├── campaigns.html           # Campaign creator & list
│   ├── campaign-detail.html     # Funnel visualizer, variants & lead timeline
│   ├── mailboxes.html           # Mailbox manager & DNS health cards
│   ├── replies.html             # Replies inbox with sentiment tagger
│   ├── suppression.html         # Global suppression list
│   ├── settings.html            # System settings & port 25 diagnostics
│   ├── css/style.css            # Dark/clean responsive CSS theme
│   └── vendor/chart.js          # Vendored offline Chart.js
├── data/
│   └── disposable.txt           # 300+ disposable domain blacklist
├── scripts/
│   └── update-disposable.js     # Updater script for disposable domains
├── test/                        # Complete node:test test suite (67 tests)
│   ├── crypto_db.test.js
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
- Node.js 20.0.0 or higher
- An internet connection for initial dependency installation

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the project root:
```ini
# Server Ports
ADMIN_PORT=3000
PUBLIC_PORT=3001

# Base URL for Tracking & Unsubscribe Links (Tunnel or Domain)
PUBLIC_BASE_URL=https://track.yourdomain.com

# Cryptography (64 hex characters = 32 bytes for AES-256-GCM)
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# Optional Admin API Protection (leave blank for local access)
API_KEY=

# Database Path
DB_PATH=mailcheck.db

# Global Concurrency Limits
MAX_GLOBAL_CONCURRENCY=10
RATE_LIMIT_PER_HOST_MS=1500
```

> **Tip:** You can generate a random 32-byte hex key using Node.js:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

### 4. Seed Disposable Domain Blacklist
```bash
npm run update-disposable
```

### 5. Running the Servers
You can start both servers concurrently in development or in production:

**Start Admin Dashboard (Internal: `127.0.0.1:3000`):**
```bash
npm start
```

**Start Public Tracking Server (Public: `0.0.0.0:3001`):**
```bash
npm run public
```

---

## Tunnel & Reverse Proxy Setup

Tracking pixels, click redirects, and one-click unsubscribe links must be reachable by recipients on the internet. Because your machine is on a private local network, you expose **only port 3001** via a secure reverse tunnel.

### Option A: Cloudflare Tunnel (Recommended)
1. Install `cloudflared`:
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```
2. Cloudflare will assign a temporary or custom hostname (e.g., `https://cold-track.yourdomain.com`).
3. Set `PUBLIC_BASE_URL=https://cold-track.yourdomain.com` in your `.env` or in the **Settings** page in the dashboard.

### Option B: ngrok
1. Start an HTTP tunnel to port 3001:
   ```bash
   ngrok http 3001
   ```
2. Copy the resulting forwarding URL (e.g., `https://abc-123.ngrok-free.app`).
3. Set `PUBLIC_BASE_URL=https://abc-123.ngrok-free.app` in your `.env` or in **Settings**.

> [!WARNING]
> Never expose port 3000 to the tunnel! Port 3000 contains your private dashboard and SQLite database controls. Only port 3001 is designed to receive external web traffic.

---

## Outbound Port 25 Diagnostics

During email verification (Module 1), MailCheck probes destination MX servers over raw TCP port 25 without sending data. Many residential Internet Service Providers (ISPs) block outbound port 25 to reduce spam.

- **Startup Check**: MailCheck performs an automatic outbound TCP probe at startup.
- **Graceful Degradation**: If port 25 is blocked by your ISP, MailCheck will **not** crash or fail verification checks. Instead:
  1. A yellow diagnostic banner is shown in the dashboard.
  2. The verifier skips SMTP probing and settles on a verdict of `unknown` with score `50` and reason `"Outbound SMTP port 25 blocked by local network/ISP"`.
  3. Syntax, typo, disposable, role, and MX checks continue to function normally.
- **Unblocking Port 25**: If you run MailCheck on a VPS (e.g., Hetzner, DigitalOcean, Linode, AWS), you can request outbound port 25 unblocking through their support console to enable full live SMTP handshakes.

---

## Deep Dive: The 4 Core Modules

### Module 1: Email Verification Pipeline
The verification engine executes an ordered pipeline that stops early on hard failures:
1. **RFC 5322 Syntax**: Validates structure, ensures local part <= 64 characters, total length <= 254 characters, and prevents consecutive dots.
2. **Typo Correction**: Computes Levenshtein distance <= 2 against known popular domains (e.g. `gmai.com` -> `gmail.com`).
3. **Disposable Domain List**: Checks domain against 300+ disposable email services loaded from `data/disposable.txt`.
4. **Role Accounts**: Flags administrative mailboxes (`info@`, `admin@`, `support@`, `sales@`, `noreply@`, `postmaster@`).
5. **DNS MX Lookup**: Resolves mail exchange records with fallback to direct A/AAAA records.
6. **Direct Port 25 SMTP Probing**: Issues `EHLO`, `MAIL FROM`, `RCPT TO <target>`, `RCPT TO <random>`, followed immediately by `QUIT`. Never issues `DATA`. Handles multi-line replies and multi-MX fallbacks with a 12s timeout.
7. **Catch-All Detection**: Flags domains accepting any random local-part and caches the result for 24 hours in SQLite.
8. **Greylisting Handling**: On a `4xx` RCPT response, retries at 5m, 15m, and 45m before classifying as `risky`.
9. **Provider Privacy Masking**: Mailbox providers that return fake `250 OK` for all addresses (Microsoft Outlook/Hotmail, Yahoo, and Apple iCloud) are never marked `deliverable` from a 250 alone; they are marked `risky` with a provider reason.
10. **Bulk Verification with SSE**: Upload CSV or paste emails; progress streams to the frontend via Server-Sent Events (SSE).

### Module 2: Campaign Setup & Sending Engine
- **Lead Import & Scrubbing**: Automatically checks verification verdict upon import. Refuses to send to `undeliverable` or `unknown` contacts.
- **Multi-Step Sequences**: Create unlimited follow-up steps with custom delay intervals and `"send only if no reply"` logic.
- **Threading Engine**: Follow-up steps maintain legitimate email threads by setting RFC 2822 `In-Reply-To` and `References` headers to the first step's `Message-ID`, automatically prepending `"Re:"` to the subject.
- **A/B Testing**: Sequence steps support multiple subject line variants with equal rotation and per-variant performance reporting.
- **Template Rendering**: Supports variable placeholders with fallbacks (`{{first_name|there}}`, `{{company|your team}}`, `{{custom.role}}`) and nested spintax (`{Hi|Hello|Hey {there|friend}}`).
- **CAN-SPAM & GDPR Compliance**:
  - Requires a physical postal address before any campaign can launch.
  - Automatically appends physical address footer to every outgoing email.
  - Generates RFC 8058 compliant `List-Unsubscribe` (mailto + https) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
- **Crash-Safe Scheduler**: Uses atomic SQLite transactions (`UPDATE lead_steps SET status = 'claimed' ...`) so that sudden power loss, process termination, or unhandled exceptions never cause duplicate sends.

### Module 3: Tracking & Analytics Engine
- **Open Tracking**: Injects a 1x1 transparent GIF with a unique 128-bit hex token per recipient.
- **Bot-Open Filtering**: Machine opens caused by Apple Mail Privacy Protection (AMPP), GoogleImageProxy, and hits occurring within 5 seconds of dispatch are tagged as `is_probable_bot = 1`. The dashboard displays **Unique Opens** and **Likely Real Opens** separately.
- **Click Tracking**: Automatically rewrites HTML links to `/t/c/:token` while leaving `mailto:` and unsubscribe links untouched.
- **IMAP Reply Listener**: Polls connected mailboxes or uses IMAP IDLE to capture incoming replies, detects auto-replies / out-of-office notifications via RFC 3834 headers, and stops future sequence steps upon human replies.
- **RFC 3464 DSN Bounce Handling**: Analyzes incoming `multipart/report` DSN messages and `mailer-daemon` notifications to distinguish between hard (5.x.x) and soft (4.x.x) bounces, marks leads as bounced, and automatically suppresses them.
- **Metric Formulas**: All formulas are centralized in `src/stats/queries.js` and covered by automated unit tests.

### Module 4: Mailbox Warm-up Engine
- **Peer-to-Peer Pool**: Warm-up mailboxes exchange realistic business correspondence within a closed pool of your own connected mailboxes (requires >= 2 mailboxes, recommended 3+).
- **Ramp-Up Schedule**: Configurable ramp starting at 3 emails/day on Day 1, ramping +2/day up to a 40/day cap, followed by maintenance at ~15/day.
- **Realistic Jitter**: Sends are distributed randomly throughout the configured send window rather than in predictable bursts.
- **Spam Rescue**: Partner mailboxes check their Spam folder via IMAP. If a warm-up email landed in Spam, it is moved to the Inbox, marked as read, and starred, logging a `spam_rescued` event.
- **Conversational Threads**: Partner mailboxes automatically reply to ~35% of emails with natural delays (5m to 6h), simulating real conversation depth.
- **Health & Reputation Indicator**: Calculates a rolling 7-day inbox placement rate and reputation score (0-100). Automatically pauses warm-up and campaign sends if placement drops below 70% or repeated authentication errors occur.

---

## Testing & Quality Assurance

MailCheck includes a comprehensive, deterministic test suite built on the native Node.js test runner (`node:test`). Tests run completely in-process using an in-memory SQLite database and mock network sockets.

To run the entire test suite:
```bash
npm test
```

### Test Suite Breakdown (67 Tests, 35 Suites, 100% Passing)
- `test/crypto_db.test.js`: AES-256-GCM encryption/decryption, auth tag tamper resistance, token generation, IP hashing, database schema migrations.
- `test/verifier.test.js`: Syntax RFC 5322, typo recommendations, disposable list matching, role accounts, score weighting, and mock SMTP handshakes.
- `test/mailboxes.test.js`: Mailbox CRUD, credential encryption at rest, SPF/DKIM/DMARC/MX DNS check logic, and ramp-up quota math.
- `test/campaigns.test.js`: Spintax parsing, variable substitution, click link rewriting, physical postal address validation, and double-send prevention.
- `test/tracking.test.js`: Bot-open detection heuristics, 1x1 GIF serving, click redirecting, and RFC 8058 one-click unsubscribe handling.
- `test/replies_bounces.test.js`: Auto-reply detection, DSN bounce classification, hard bounce suppression, and sequence cancellation.
- `test/stats.test.js`: Centralized metric formulas, rate rounding, funnel breakdowns, and lead segment filtering.
- `test/warmup.test.js`: Ramp-up math, template repository validation, pool send/receive cycles, and rolling health calculations.
- `test/integration.test.js`: Full end-to-end integration test running fake SMTP and Fastify servers to simulate a complete campaign lifecycle (Send -> Open -> Click -> Reply -> Bounce -> Stats Verification).

---

## What Cannot Be Tested Without Real Mailboxes, Port 25, or Public Tunnel

While the automated test suite provides 100% test coverage for logic, state transitions, parsing, encryption, and simulation, certain real-world factors cannot be tested purely in a simulated local test environment:

1. **Live Port 25 TCP Handshakes against Big Tech MX Servers**:
   - In automated tests, a local mock socket simulates the SMTP handshake.
   - Testing real live connections to `gmail-smtp-in.l.google.com` or `outlook.com` requires an unblocked residential or VPS network with outbound port 25 access and genuine IP reputation.
2. **Authenticated Production SMTP Submissions & IMAP IDLE**:
   - Automated tests utilize in-memory mock transports and net servers.
   - Real authentication against Google Workspace App Passwords, Microsoft 365 OAuth/Basic, or Amazon SES requires active credentials and live TLS handshakes.
3. **Real Inbound Tracking Hits from Email Clients**:
   - The test suite simulates HTTP GET requests from Apple Mail and Google Image Proxy using Fastify's `.inject()`.
   - Real-world verification requires sending an actual email to a Gmail or Apple Mail inbox, having the user open it in the native client, and watching the live request traverse the Cloudflare Tunnel into the public server on port 3001.
4. **Live External DNS Propagation & DKIM Selectors**:
   - Automated tests simulate DNS record lookups.
   - Real SPF/DKIM/DMARC evaluation depends on public DNS propagation of your custom domain's TXT records across authoritative nameservers.
5. **Real ISP Spam Folder Placement**:
   - MailCheck's warm-up engine simulates spam rescue via IMAP folder moving within the pool.
   - Real inbox placement rates at consumer webmail providers depend on Google Postmaster Tools, Microsoft SNDS, and recipient domain filtering algorithms.

---

## License

MIT License. Designed and built cleanly from first principles for self-hosted sovereign email operations.
