/**
 * Topology Module
 *
 * Provides TopologyOracle for freezing pool dependencies.
 * After freeze, RPC writes are blocked and only gRPC can update cache.
 */

export {
    TopologyOracleImpl,
    createTopologyOracle,
    type FreezeResult,
    type ActivationResult,
} from './TopologyOracleImpl.js';

export {
    setBootstrapHandler,
    type BootstrapEvent,
    type BootstrapHandler,
} from './fetchPoolDeps.js';

export {
    checkPoolBoundary,
    checkClmmBoundary,
    checkDlmmBoundary,
    formatBoundaryReason,
    type BoundaryCheckResult,
    type BoundaryCheckConfig,
} from './boundaryCheck.js';
