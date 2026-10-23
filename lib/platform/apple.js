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
export { createApplePlatform };
