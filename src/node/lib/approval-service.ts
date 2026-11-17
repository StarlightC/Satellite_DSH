/**
 * In-process (non-Remote) Cordis service through which other Satellite tool rows obtain
 * a narrow delegated-approval CONSUMER of this node row. It exposes no issuer, no
 * binding and no identity minting; it is not a Remote method, so models and clients
 * cannot reach it. It lives and dies with the node row: unload disposes it, and the
 * node runtime's issuer release invalidates every binding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { DELEGATED_APPROVAL_SERVICE } from '../../lib/delegated-approval.ts'
import type { BrokerConsumer } from '../../lib/delegated-approval.ts'

export interface DelegatedApprovalServiceOptions {
  readonly consumer: () => BrokerConsumer
}

export class SatelliteDelegatedApproval extends Service {
  private readonly createConsumer: () => BrokerConsumer

  constructor(ctx: Context, options: DelegatedApprovalServiceOptions) {
    super(ctx, DELEGATED_APPROVAL_SERVICE)
    this.createConsumer = options.consumer
  }

  /** A fresh consumer; the caller disposes it with its own lifecycle. */
  consumer(): BrokerConsumer {
    return this.createConsumer()
  }
}
