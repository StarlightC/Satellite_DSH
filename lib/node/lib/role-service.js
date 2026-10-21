import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region src/node/lib/role-service.ts
var SatelliteRoles = class extends TypertRemoteService {
	readCatalog;
	constructor(ctx, options) {
		super(ctx, "satelliteRoles");
		this.readCatalog = options.describe;
		Remote(this.describe, {
			kind: "method",
			name: "describe",
			static: false,
			private: false,
			access: {
				has: (value) => "describe" in value,
				get: (value) => value.describe
			},
			metadata: Object.create(null),
			addInitializer: (initialize) => initialize.call(this)
		});
	}
	/** Declarations and registered bindings, not readiness, authorization or run history. */
	describe() {
		return this.readCatalog();
	}
};
//#endregion
export { SatelliteRoles };
