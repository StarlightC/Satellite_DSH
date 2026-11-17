import { Service } from "@deepseek-ai/cordis";
//#region src/lib/delegated-approval.ts
/** Name of the node row's internal, non-Remote consumer service. */
const DELEGATED_APPROVAL_SERVICE = "satelliteDelegatedApproval";
//#endregion
//#region src/node/lib/approval-service.ts
/**
* In-process (non-Remote) Cordis service through which other Satellite tool rows obtain
* a narrow delegated-approval CONSUMER of this node row. It exposes no issuer, no
* binding and no identity minting; it is not a Remote method, so models and clients
* cannot reach it. It lives and dies with the node row: unload disposes it, and the
* node runtime's issuer release invalidates every binding.
*/
var SatelliteDelegatedApproval = class extends Service {
	createConsumer;
	constructor(ctx, options) {
		super(ctx, DELEGATED_APPROVAL_SERVICE);
		this.createConsumer = options.consumer;
	}
	/** A fresh consumer; the caller disposes it with its own lifecycle. */
	consumer() {
		return this.createConsumer();
	}
};
//#endregion
export { SatelliteDelegatedApproval };
