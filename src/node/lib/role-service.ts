/** Read-only, live role documentation over the Host's native Remote carrier. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RoleCatalog } from './role-catalog.js'

export interface RoleServiceOptions {
  readonly describe: () => RoleCatalog
}

export class SatelliteRoles extends TypertRemoteService {
  private readonly readCatalog: () => RoleCatalog

  constructor(ctx: Context, options: RoleServiceOptions) {
    super(ctx, 'satelliteRoles')
    this.readCatalog = options.describe
    // Apply the public standard decorator explicitly: the ES2024 bundle target
    // does not lower decorator syntax and supported Node releases cannot parse it.
    // The native Gateway still reads the protocol-owned marker, not a private copy.
    Remote<SatelliteRoles, [], RoleCatalog>(this.describe, {
      kind: 'method', name: 'describe', static: false, private: false,
      access: { has: (value) => 'describe' in value, get: (value) => value.describe },
      metadata: Object.create(null) as DecoratorMetadata,
      addInitializer: (initialize) => initialize.call(this),
    })
  }

  /** Declarations and registered bindings, not readiness, authorization or run history. */
  describe(): RoleCatalog {
    return this.readCatalog()
  }
}
