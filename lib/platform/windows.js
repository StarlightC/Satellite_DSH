//#region src/platform/windows.ts
const WINDOWS_UNSUPPORTED_REASON = "Windows host execution is not implemented; only the Apple (macOS) host route is supported";
function windowsPlatform() {
	return Object.freeze({
		id: "windows",
		supported: false,
		unsupportedReason: WINDOWS_UNSUPPORTED_REASON
	});
}
//#endregion
export { WINDOWS_UNSUPPORTED_REASON, windowsPlatform };
