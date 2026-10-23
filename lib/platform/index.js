import { posix, win32 } from "node:path";
//#region src/platform/apple.ts
/** POSIX shell 引用：每个参数都作为单引号字符串；内层单引号用 `'\''` 闭合。 */
function quote(text) {
	return `'${text.replaceAll("'", "'\\''")}'`;
}
/** 组装受约束的解析器命令：`env -i <runtime> … - <argv>`。 */
function skillScriptCommand(input) {
	if (!input.environmentExecutable) throw new Error("Apple parser invocation requires an environment executable");
	return [
		input.environmentExecutable,
		"-i",
		input.runtimeExecutable,
		...input.runtime === "node" ? ["--input-type=module", "-"] : ["-I", "-"],
		...input.args
	].map(quote).join(" ");
}
function createApplePlatform() {
	const platform = {
		id: "apple",
		supported: true,
		gradleWrapperName: "gradlew",
		pathSeparator: "/",
		parserEnvironmentExecutableName: "env",
		parserEnvironmentDescription: "empty (env -i)",
		parserEnvironment: Object.freeze({
			NODE_OPTIONS: "",
			PYTHONPATH: "",
			PYTHONSTARTUP: ""
		}),
		parserRuntimeName: (runtime) => runtime === "node" ? "node" : "python3",
		gradleWrapperPath: (root) => `${root}${root.endsWith("/") ? "" : "/"}gradlew`,
		isAbsoluteHostPath: (path) => path.startsWith("/"),
		skillScriptCommand
	};
	return Object.freeze(platform);
}
//#endregion
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
//#region src/platform/paths.ts
/**
* Pure host-path syntax used by platform-independent/static inputs.
* Recognising Windows syntax does not enable Windows execution; dynamic execution
* still requires a supported adapter and canonical filesystem containment.
*/
function isAbsoluteHostPathSyntax(path) {
	return posix.isAbsolute(path) || win32.isAbsolute(path);
}
//#endregion
//#region src/platform/index.ts
const APPLE_MARKERS = ["/System/Library/CoreServices/SystemVersion.plist", "/usr/bin/sw_vers"];
const LINUX_MARKERS = ["/etc/os-release", "/proc/version"];
function probeError(error, signal) {
	signal.throwIfAborted();
	if (error instanceof Error && error.name === "AbortError") throw error;
	const code = error && typeof error === "object" && "code" in error ? error.code : void 0;
	return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
}
async function markerPresent(fs, path, signal) {
	signal.throwIfAborted();
	try {
		const target = await fs.resolve(path, { signal });
		signal.throwIfAborted();
		const info = await fs.stat(target, signal);
		signal.throwIfAborted();
		return info === void 0 ? "missing" : info.type === "file" ? "present" : "unavailable";
	} catch (error) {
		return probeError(error, signal);
	}
}
function unknownPlatform(reason) {
	return Object.freeze({
		id: "unknown",
		supported: false,
		unsupportedReason: reason
	});
}
async function detectHostPlatform(params) {
	const { fs, signal } = params;
	signal.throwIfAborted();
	const terminal = await params.terminalEnvironment(signal);
	signal.throwIfAborted();
	if (terminal.platform === "windows") return windowsPlatform();
	if (terminal.platform !== "posix") return unknownPlatform("unknown terminal family; refusing to guess");
	const apple = await Promise.all(APPLE_MARKERS.map((path) => markerPresent(fs, path, signal)));
	const linux = await Promise.all(LINUX_MARKERS.map((path) => markerPresent(fs, path, signal)));
	signal.throwIfAborted();
	if ([...apple, ...linux].includes("unavailable")) return unknownPlatform("host marker probe unavailable or invalid; refusing to infer absence");
	const applePresent = apple.every((marker) => marker === "present");
	const linuxPresent = linux.some((marker) => marker === "present");
	if (applePresent && linuxPresent) return unknownPlatform("host markers conflict (Apple and Linux markers both present); refusing to guess");
	if (applePresent) return createApplePlatform();
	if (linuxPresent) return linuxPlatform();
	return unknownPlatform("no supported host marker matched; only the Apple (macOS) host route is supported");
}
//#endregion
export { LINUX_UNSUPPORTED_REASON, WINDOWS_UNSUPPORTED_REASON, createApplePlatform, detectHostPlatform, isAbsoluteHostPathSyntax, linuxPlatform, windowsPlatform };
