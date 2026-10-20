//#region src/android/lib/registration.ts
function createSlotRegistration(params) {
	const { slots } = params;
	const wanted = params.extensions ?? (params.extension ? [params.extension] : []);
	if (wanted.length === 0) throw new TypeError("createSlotRegistration requires at least one extension");
	const disposers = /* @__PURE__ */ new Map();
	return {
		sync() {
			for (const extension of wanted) {
				const declared = slots.hasSlot(extension.slot);
				const dispose = disposers.get(extension.id);
				if (declared && !dispose) disposers.set(extension.id, slots.register(extension));
				else if (!declared && dispose) {
					dispose();
					disposers.delete(extension.id);
				}
			}
		},
		dispose() {
			for (const dispose of [...disposers.values()].reverse()) dispose();
			disposers.clear();
		},
		get registered() {
			return disposers.size > 0;
		}
	};
}
//#endregion
export { createSlotRegistration };
