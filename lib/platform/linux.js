//#region src/platform/linux.ts
const LINUX_UNSUPPORTED_REASON = "Linux host execution is not implemented; only the Apple (macOS) host route is supported";
function linuxPlatform() {
	return Object.freeze({
		id: "linux",
		supported: false,
		unsupportedReason: LINUX_UNSUPPORTED_REASON
	});
}
//#endregion
export { LINUX_UNSUPPORTED_REASON, linuxPlatform };
