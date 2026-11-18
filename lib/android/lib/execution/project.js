//#region src/android/lib/execution/project.ts
const STATIC_LEAD_LIMIT = 50;
const CLI_VERSION_POLICY = "stable-semver + validated-describe";
/** 观测有效期：过期必须重新发现，不能把旧模型套到新批准上。 */
const OBSERVATION_TTL_MS = 300 * 1e3;
/** `android --version` 的事实格式：稳定 semver（可带 build metadata），不是版本白名单。 */
function parseAndroidCliVersion(output) {
	const text = output.trim();
	return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(text) ? text : void 0;
}
/**
* 解析 Android CLI `describe` 的执行相关结构；无关扩展行可以保留。
*
* 报告是行式的：锚点行 + 缩进的 Task/Variant/APK 三级结构。
* 任何锚点缺失、重复、路径非绝对或形状不符都抛错——宁可不可用，不猜。
*/
function parseAndroidCliDescribe(stdout, canonicalProjectRoot, paths) {
	const lines = stdout.replaceAll("\r\n", "\n").split("\n");
	const expectedWrapper = paths.gradleWrapperPath(canonicalProjectRoot);
	if (!paths.isAbsoluteHostPath(expectedWrapper)) throw new TypeError("Gradle wrapper path must be absolute");
	const anchors = [
		`Target project directory: ${canonicalProjectRoot}`,
		`Project directory exists: ${canonicalProjectRoot}`,
		"Parsed tasks:",
		"gradlew completed successfully."
	];
	const errors = [
		"target does not match the requested project root",
		"did not confirm the requested project directory",
		"report is missing its task section",
		"did not complete Gradle description successfully"
	];
	const positions = anchors.map((anchor, index) => {
		const position = lines.indexOf(anchor);
		if (position < 0) throw new TypeError(`Android CLI ${errors[index]}`);
		const prefix = index < 2 ? anchor.slice(0, anchor.indexOf(":") + 1) : anchor;
		if (lines.filter((line) => line.startsWith(prefix)).length !== 1) throw new TypeError(`Android CLI reported duplicate or conflicting anchor: ${prefix}`);
		return position;
	});
	if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) throw new TypeError("Android CLI report anchors are out of order");
	const modules = /* @__PURE__ */ new Map();
	let currentModule;
	let currentVariant;
	for (const [index, line] of lines.entries()) {
		const structural = /^\s*(?:Task|Variant|APK):/u.test(line);
		if (structural && (index <= positions[2] || index >= positions[3])) throw new TypeError("Android CLI task structure is outside its task section");
		const task = /^Task: (:[^:\s]+(?::[^:\s]+)*)$/u.exec(line);
		if (task !== null) {
			const path = task[1];
			if (modules.has(path)) throw new TypeError(`Android CLI reported duplicate module ${path}`);
			currentModule = {
				path,
				variants: /* @__PURE__ */ new Map()
			};
			modules.set(path, currentModule);
			currentVariant = void 0;
			continue;
		}
		const variant = /^ {4}Variant: ([A-Za-z][A-Za-z0-9_]*)$/u.exec(line);
		if (variant !== null) {
			if (currentModule === void 0) throw new TypeError("Android CLI reported a variant before its module");
			const name = variant[1];
			if (currentModule.variants.has(name)) throw new TypeError(`Android CLI reported duplicate variant ${currentModule.path}:${name}`);
			currentVariant = [];
			currentModule.variants.set(name, currentVariant);
			continue;
		}
		const apk = /^ {8}APK: (.+?)(?: \(Exists\))?$/u.exec(line);
		if (apk !== null) {
			if (currentVariant === void 0) throw new TypeError("Android CLI reported an APK before its variant");
			const path = apk[1];
			if (!paths.isAbsoluteHostPath(path)) throw new TypeError(`Android CLI reported a non-absolute APK path: ${path}`);
			currentVariant.push({
				kind: "apk",
				path
			});
			continue;
		}
		if (structural) throw new TypeError(`Android CLI reported malformed task structure: ${line}`);
	}
	if (modules.size === 0) throw new TypeError("Android CLI describe report declared no modules");
	for (const module of modules.values()) if (module.variants.size === 0) throw new TypeError(`Android CLI module has no variants: ${module.path}`);
	return {
		gradleWrapper: expectedWrapper,
		modules: [...modules.values()].map((module) => ({
			path: module.path,
			variants: [...module.variants.entries()].map(([name, artifacts]) => ({
				name,
				artifacts
			}))
		}))
	};
}
/** 观测只定位事实，不授予执行；id 不透明、按调用方隔离、有寿命。 */
function createObservationStore(now, randomId, ttlMs = OBSERVATION_TTL_MS) {
	const entries = /* @__PURE__ */ new Map();
	return {
		put(ownerId, facts, modelDigest) {
			const observation = Object.freeze({
				id: randomId(),
				ownerId,
				facts,
				expiresAt: now() + ttlMs,
				modelDigest
			});
			entries.set(observation.id, observation);
			return observation;
		},
		get(id) {
			const observation = entries.get(id);
			if (!observation) return {
				ok: false,
				code: "TARGET_REQUIRED",
				message: "unknown or expired build observation id"
			};
			if (observation.expiresAt <= now()) {
				entries.delete(id);
				return {
					ok: false,
					code: "TARGET_CHANGED",
					message: "build observation expired; discover again"
				};
			}
			return {
				ok: true,
				observation
			};
		},
		/** 只允许观测所有者消费；跨调用方/跨会话的 id 一律拒绝。 */
		getFor(id, ownerId) {
			const found = this.get(id);
			if (!found.ok) return found;
			if (found.observation.ownerId !== ownerId) return {
				ok: false,
				code: "TARGET_CHANGED",
				message: "build observation belongs to another caller"
			};
			return found;
		},
		size() {
			return entries.size;
		}
	};
}
/** 从项目根与文件系统能力构造静态线索；不执行任何进程。 */
async function inspectStaticProject(params) {
	const { projectRoot, fs, signal } = params;
	const rootPath = projectRoot;
	const leads = [];
	const missing = [];
	const diagnostics = [];
	const unreadable = /* @__PURE__ */ new Set();
	let truncated = false;
	const resolveIn = async (relative) => fs.resolve(relative, {
		cwd: rootPath,
		signal
	});
	const exists = async (relative) => {
		try {
			const target = await resolveIn(relative);
			return await fs.stat(target, signal) ? fs.processPath(target) : void 0;
		} catch (error) {
			if (signal.aborted || error instanceof Error && error.name === "AbortError") throw error;
			unreadable.add(relative);
			diagnostics.push(`Could not inspect ${relative}: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	};
	for (const [kind, relative, detail] of [
		[
			"wrapper",
			"gradlew",
			"Gradle wrapper script; not executed by static inspection"
		],
		[
			"wrapper",
			"gradlew.bat",
			"Windows Gradle wrapper script; not executed by static inspection"
		],
		[
			"settings",
			"settings.gradle",
			"Gradle settings file (Groovy)"
		],
		[
			"settings",
			"settings.gradle.kts",
			"Gradle settings file (Kotlin DSL)"
		],
		[
			"build-file",
			"build.gradle",
			"root build file (Groovy)"
		],
		[
			"build-file",
			"build.gradle.kts",
			"root build file (Kotlin DSL)"
		]
	]) {
		const found = await exists(relative);
		if (found) leads.push({
			kind,
			path: found,
			detail
		});
	}
	if (!leads.some((lead) => lead.kind === "wrapper") && !unreadable.has("gradlew") && !unreadable.has("gradlew.bat")) missing.push("gradlew");
	let entries = [];
	try {
		entries = await fs.listDir(await resolveIn("."), signal);
	} catch (error) {
		if (signal.aborted || error instanceof Error && error.name === "AbortError") throw error;
		diagnostics.push(`Could not list candidate directories: ${error instanceof Error ? error.message : String(error)}`);
	}
	let inspected = 0;
	for (const entry of entries) {
		if (entry.type !== "directory") continue;
		if (entry.name.startsWith(".") || entry.name === "build" || entry.name === "node_modules") continue;
		if (inspected >= 50) {
			truncated = true;
			diagnostics.push(`Candidate-directory scan truncated after 50; remaining directories were not inspected`);
			break;
		}
		inspected += 1;
		for (const candidate of ["build.gradle", "build.gradle.kts"]) {
			const found = await exists(`${entry.name}/${candidate}`);
			if (!found) continue;
			leads.push({
				kind: "module-dir",
				path: found,
				detail: "directory contains a Gradle build file; module identity and tasks are NOT verified by static inspection"
			});
			break;
		}
	}
	if (!truncated && diagnostics.length === 0 && !leads.some((lead) => lead.kind === "module-dir")) missing.push("module build files");
	return Object.freeze({
		projectRoot: rootPath,
		leads: Object.freeze(leads),
		missing: Object.freeze(missing),
		truncated,
		diagnostics: Object.freeze(diagnostics),
		provenance: "static-text",
		verified: false
	});
}
/** 动态事实的摘要：批准前后逐字段比较用。 */
function digestDynamicFacts(sha256, facts) {
	return sha256(JSON.stringify({
		projectRoot: facts.projectRoot,
		gradleWrapper: facts.gradleWrapper,
		cliVersion: facts.cliVersion,
		modules: facts.modules
	}));
}
/** 一次动态发现需要的执行模式：发现会创建元数据/缓存，按 workspace-write 处理。 */
const DISCOVERY_MODE = "workspace-write";
//#endregion
export { CLI_VERSION_POLICY, DISCOVERY_MODE, OBSERVATION_TTL_MS, STATIC_LEAD_LIMIT, createObservationStore, digestDynamicFacts, inspectStaticProject, parseAndroidCliDescribe, parseAndroidCliVersion };
