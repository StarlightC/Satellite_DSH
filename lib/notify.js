//#region src/lib/notify.ts
function createNotifier() {
	const listeners = /* @__PURE__ */ new Set();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify() {
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		},
		get size() {
			return listeners.size;
		}
	};
}
//#endregion
export { createNotifier };
