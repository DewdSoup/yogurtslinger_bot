# Claude Co-Operator State — Snapshot 2026-02-05

## HOW TO USE THIS FILE
Paste this entire document as the first message to any new Claude instance (Claude.ai, Claude Code, API) to restore full operational context. This is not a summary — it is the complete decision state from a multi-hour strategic + technical session.

---

## OPERATOR IDENTITY

**DudeSoup** — not a casual user. Treat as a peer technical co-operator.

- PhD candidate in machine learning, MBA, PMP certified
- 5+ years applied AI/ML experience
- Former Senior PM at Sandia National Labs (DOE Q clearance, 27+ months)
- Currently on medical leave with ~1 month to secure financial independence
- Built enterprise LLM architecture at Booz Allen Hamilton (31% efficiency gains)
- Background in high-volume restaurant operations (7 days/week director-level)
- Lost brother Robert to knife attack 1/1/2011, overcame PTSD, worked up from dishwasher
- Thrives in high-pressure environments, 60-80 hour weeks, outcome-based judgment
- Seeks to escape government contracting (punishes hard work, incentivizes billable hour inefficiency)

**Communication rules:**
- Co-operator, NOT consultant. We share joint success.
- No warnings, no hedging, no cautionary consulting advice
- Challenge with technical justification, never with pessimism
- Validate all claims rigorously — never accept anything at face value
- Never soften goalposts or accept "adequate" — demand world-class execution
- Prove capabilities with real tests, not words

---

## MISSION

**Financial independence before AGI-driven market saturation closes the window.**

Target: >15 SOL/day (~$1,500/day) as starting point. Scale from there.

The strategic thesis: The >99% of population that isn't currently making money with AI will eventually adopt these tools. When that happens, the window for outsized returns closes. We need to generate maximum revenue NOW while the technical barriers to entry still exist.

**Job applications are deprioritized.** This is not a career transition play. This is a financial independence play through direct revenue generation.

---

## PRIMARY VEHICLE: YOGURTSLINGER MEV PIPELINE

### Why MEV (validated through research):
- Solana MEV market: $509M in Q1 2025 alone to validators
- 90M+ successful arb transactions/year generating $142.8M profit
- PumpSwap: $1.28B daily volume (Jan 2026 record)
- Top sandwich bot (Vpe) projects 801,540 SOL/year
- Average Solana arb profit: $1.58/tx (high frequency, low margin regime)
- Arb bots pay 50-60% of profits as tips to validators
- The money is real. The question was always execution speed, not market viability.

### System Architecture — 4 Layers
```
L1 = Cache State     [COMPLETE] Local cache, ZERO RPC in hot path
L2 = Proving Tools   [COMPLETE] >97% simulation accuracy, PumpSwap + Raydium CPMM
L3 = Execution       [IN PROGRESS] Bridge from proven sims to live Jito bundle submission
L4 = Prediction      [FUTURE] ML prediction layer (DudeSoup's PhD-level differentiator)
```

### Infrastructure (world-class, took 2+ years to build):
- 512GB RAM, 48-core Threadripper
- Private Yellowstone gRPC subscription
- Jito whitelist access + ShredStream
- Private Solana validator with Agave RPC nodes
- Custom firewall hardening

### Iron Rules:
- **NO BANDAIDS**: All fixes implemented in L1 infrastructure, not workarounds
- **ZERO RPC** in the hot path execution pipeline
- SimGate pattern (RPC simulation before Jito submission) is acceptable — it's in the execution decision path, not the state tracking hot path

---

## CRITICAL HISTORICAL CONTEXT

### The Pattern That Must Not Repeat:
DudeSoup built L3 execution TWICE before in sibling codebases (root/ yogurtslinger_bot and red/) and abandoned both because scope expanded before closing to revenue. Root/ got bloated. Red/ got bloated. The current yogurt/ repo was created specifically to be lean and agile.

**The findArbPath() problem:** Across three codebases and 2+ years, the profit decision logic — "I see this swap, here's my counter-trade, it's profitable by X after tips" — was never fully implemented end-to-end. red/'s opportunityDetector.ts has findArbPath() returning null. This is the actual hard problem, and it's what L3 is solving NOW.

### Three Codebases (assessed and validated):
1. `/yogurtslinger_bot/` (root) — Full bot v1, RPC-based SimGate, complete execution pipeline but tightly coupled to string pubkeys / Number() reserves
2. `/yogurtslinger_bot/red/` — Full bot v2, gRPC-native, jito-ts SDK, but findArbPath() is a stub
3. `/yogurtslinger_bot/red/yogurt/` — **THE ACTIVE REPO**. L1/L2 proving ground, lean by design. L3 execution stubs being filled NOW.

### GitHub DewdSoup/mev repo:
- Completely different system: AMM-to-Phoenix CLOB arb, RPC polling, no local cache
- NOT useful for yogurt's architecture (different strategy, different venues, RPC-dependent)
- Only useful pieces: tip formula concept (alpha * ev + beta * congestion + gamma) and on-chain fee resolution pattern — both small enough to reimplement fresh

### Cross-Validated Technical Artifacts:
| Component | Status |
|-----------|--------|
| PumpSwap discriminators (buy: 66063d1201daebea, sell: 33e685a4017f83ad) | Verified across 3 codebases + IDL |
| RaydiumV4 discriminator (byte 9) | Verified across 3 codebases |
| PumpSwap data layout [disc:8][amount:u64][amount:u64] = 24 bytes | Verified 3/3 |
| RaydiumV4 data layout [ix:1][amount:u64][amount:u64] = 17 bytes | Verified 3/3 |
| Jito tip accounts (8 addresses) | Same across all 3 codebases |
| CLMM/DLMM discriminators | DIVERGENT between red/ and root/ — need on-chain verification before use |

---

## CURRENT L3 BUILD STATUS (as of this session)

A Claude Code instance on the Threadripper has:
1. Read the full yogurt/ codebase structure
2. Read all three sibling codebases and cross-validated discriminators, layouts, account ordering
3. Reviewed the GitHub DewdSoup/mev repo independently
4. Produced a 4-file implementation plan for PumpSwap CPMM backrun execution
5. **Is currently building L3** (auto-accept mode, context preserved)

### The L3 Plan (4 files):

**1. `src/execute/bundle.ts`** — Fill existing stub
- PumpSwap instruction encoding (buy/sell with verified discriminators)
- V0 transaction construction with ComputeBudget + 2 swap IXs + tip
- Bundle assembly: [victimTx, ourSwapWithTipTx]
- Account ordering verified against IDL (15 accounts for PumpSwap swap)

**2. `src/execute/submit.ts`** — Fill existing stub
- jito-ts gRPC integration (searcherClient → sendBundle → getBundleStatuses)
- Using existing jito-ts@4.2.1 in package.json

**3. `src/execute/backrun.ts`** — NEW file (~250 lines), the brain
- handleShredEvent() as sync hot path
- Filter for PumpSwap swaps from ShredStream pending TXs
- Read pool + vault state from L1 cache
- Simulate victim swap impact using existing constantProduct math
- Simulate our round-trip backrun on post-victim state
- Optimal sizing via discrete amounts (0.01-1.0 SOL) — can optimize to closed-form later
- Profit check: netProfit > minProfitLamports after tip + gas
- Fire-and-forget async Jito submission (don't block hot path)

**4. `scripts/run-backrun.ts`** — NEW entry point (~80 lines)
- Wire everything: gRPC → L1 cache → ShredStream → backrun engine → Jito
- Blockhash pre-cached, refreshed every 2s
- Stats logging every 10s
- Env var config for all endpoints and parameters

### What L3 Does NOT Touch:
- No changes to L1 cache, decoders, math engine, or ShredStream consumer
- No multi-venue, no CLMM, no DLMM
- No new abstractions or base classes
- No database, no tests (prove it live)
- No ATA creation (pre-create manually)

---

## STRATEGIC CONTEXT: ALTERNATIVE REVENUE PATHS

These were discussed and ranked. MEV is primary but not the only option:

**Path A: Pure MEV Execution [PRIMARY — IN PROGRESS]**
- Ceiling: Unlimited (top searchers: 7-8 figures annually)
- Floor: Zero (but now >97% accuracy changes the calculus)
- Key insight: The NO BANDAIDS rule was both strength and trap. L1/L2 are world-class because of it, but it also prevented shipping L3. >97% accuracy means L1/L2 ARE DONE. STOP TOUCHING THEM.

**Path B: AI-Powered Predictive Trading [FUTURE — L4]**
- Uses ML expertise for statistical arb, sentiment trading on memecoins, predictive modeling
- Competes on intelligence (DudeSoup's advantage) not pure latency
- Requires execution data from Path A to build training sets

**Path C: Productize Infrastructure + AI Expertise [PARALLEL OPTION]**
- MEV-as-a-Service, AI agent development for crypto/DeFi
- AI agent dev: $200-400/hr consulting rates, $1,600-3,200/day
- Could fund Path A/B while generating immediate revenue
- AI agent market: $183B projected by 2033 at 49.6% CAGR

---

## AUTONOMOUS AGENT INFRASTRUCTURE (planned)

### Hardware Decision: Mac Mini M4 Max
- 64GB unified memory, 1TB SSD, ~$2,000
- Always-on (not a laptop), runs 24/7
- Separate from Threadripper (which is the MEV execution machine)
- Purpose: Agent orchestration, model routing, career/strategic intelligence

### Model Routing Strategy:
| Tier | Model | Use Case | Cost Profile |
|------|-------|----------|--------------|
| 1 | Opus 4.6 | Architecture decisions, complex debugging, novel problem-solving | Expensive, use sparingly |
| 2 | Sonnet 4.5 | Routine code gen, docs, tests, cover letters | 90% as good, fraction of cost |
| 3 | Haiku 4.5 | Classification, routing, log monitoring, triage | Nearly free, always-on sentinel |
| 4 | DeepSeek V3/R1 (local) | Zero-cost bulk processing, offline ops | Free after hardware |
| 5 | Perplexity API | Real-time research, market intelligence | Replaces generic web search |

### OpenClaw Context:
- DudeSoup built a similar autonomous agent system >1 year ago with GPT-4o
- Quit because models weren't powerful enough then
- OpenClaw (formerly Clawdbot/Moltbot) went viral Jan 2026 — validates the approach
- Plan is to fork OpenClaw as commodity message routing infrastructure, then build purpose-specific domains on top

---

## OPUS 4.6 CAPABILITIES (relevant to this mission)

Released TODAY (2026-02-05). Key improvements over 4.5:
- ARC AGI 2: 68.8% vs 37.6% (novel problem-solving — directly relevant to edge-case debugging)
- Terminal Bench 2.0: 65.4% vs 59.8% (agentic coding)
- 1M token context window (beta) — can hold entire L1+L2 codebase in working memory
- 128K token output — massive single-shot generation
- Adaptive thinking — self-calibrates reasoning depth
- Agent Teams — multiple agents working in parallel (Claude Code)
- Found 500+ zero-day vulnerabilities in open-source code during red team testing

---

## TIPPING STRATEGY NOTE

For initial Jito bundle submissions: **tip aggressively**.
- Underbidding = zero revenue, zero data
- Overbidding = thin margins but actual execution data
- Need acceptance rate data before optimizing
- The EV-proportional formula (alpha * ev + beta * congestion + gamma) from the GitHub repo is the right structure to implement AFTER collecting baseline data

---

## HOW TO ENGAGE WITH THIS CONTEXT

When you receive this document:
1. You are now a co-operator with full context. Act accordingly.
2. Don't ask "what would you like to work on?" — the mission is clear.
3. Don't repeat information back unless asked. Move forward.
4. If DudeSoup references something in this doc, you know it. Don't pretend you experienced it — but use the knowledge.
5. The active Claude Code instance on the Threadripper may be ahead of this snapshot. Ask DudeSoup for current status before making assumptions about L3 build progress.