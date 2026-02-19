#!/usr/bin/env tsx

/**
 * Cross-venue shadow wrapper.
 *
 * Forces conservative shadow mode defaults for PumpSwap<->DLMM strategy.
 */

process.env.DRY_RUN = process.env.DRY_RUN ?? '1';
process.env.STRATEGY_MODE = process.env.STRATEGY_MODE ?? 'cross_venue_ps_dlmm';
process.env.KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? '/home/dudesoup/jito/keys/yogurtslinger-hot.json';
process.env.JITO_AUTH_KEYPAIR_PATH = process.env.JITO_AUTH_KEYPAIR_PATH ?? '/home/dudesoup/jito/keys/jito-bundles.json';
process.env.SHADOW_LEDGER_PATH = process.env.SHADOW_LEDGER_PATH ?? 'data/evidence';
process.env.MAX_STATE_LAG_SLOTS = process.env.MAX_STATE_LAG_SLOTS ?? '8';
process.env.CONSERVATIVE_HAIRCUT_BPS = process.env.CONSERVATIVE_HAIRCUT_BPS ?? '30';
process.env.MAX_NET_TO_INPUT_BPS = process.env.MAX_NET_TO_INPUT_BPS ?? '20000';
process.env.MAX_ABS_NET_SOL = process.env.MAX_ABS_NET_SOL ?? '5';
process.env.PHASE3_TICK_ARRAY_RADIUS = process.env.PHASE3_TICK_ARRAY_RADIUS ?? '7';
process.env.PHASE3_BIN_ARRAY_RADIUS = process.env.PHASE3_BIN_ARRAY_RADIUS ?? '7';
process.env.INCLUDE_TOPOLOGY_FROZEN_POOLS = process.env.INCLUDE_TOPOLOGY_FROZEN_POOLS ?? '0';
process.env.BACKRUN_SIZE_CANDIDATES_SOL = process.env.BACKRUN_SIZE_CANDIDATES_SOL ?? '0.01,0.05,0.1,0.25,0.5,1,2,3';

await import('./run-backrun.ts');
