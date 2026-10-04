import { readRuntimeBuildIdentity } from '../../shared/orca-build-identity'

// A running host keeps its own identity when an update replaces bundle metadata.
export const RUNTIME_BUILD_IDENTITY = readRuntimeBuildIdentity()
