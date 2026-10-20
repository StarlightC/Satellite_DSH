//#region src/android/lib/execution/project.ts
const STATIC_LEAD_LIMIT = 50;
const CLI_VERSION_POLICY = "android-cli-1.0.x";
/** 观测有效期：过期必须重新发现，不能把旧模型套到新批准上。 */
const OBSERVATION_TTL_MS = 300 * 1e3;
/** `android --version` 的支持线；只接受 1.0.x 的稳定数字版本。 */
function parseAndroidCliVersion(output) {
	const text = output.trim();
	return /^1\.0\.\d+$/u.test(text) ? text : void 0;
}
/**
* 解析 Android CLI 1.0.x `describe` 报告。
*
* 报告是行式的：锚点行 + 缩进的 Task/Variant/APK 三级结构。
* 任何锚点缺失、重复、路径非绝对或形状不符都抛错——宁可不可用，不猜。
*/
function parseAndroidCliDescribe(stdout, canonicalProjectRoot, platform = "posix") {
	const lines = stdout.replaceAll("\r\n", "\n").split("\n");
	const separator = platform === "windows" ? "\\" : "/";
	const expectedWrapper = `${canonicalProjectRoot}${canonicalProjectRoot.endsWith(separator) ? "" : separator}${platform === "windows" ? "gradlew.bat" : "gradlew"}`;
	if (!lines.includes(`Target project directory: ${canonicalProjectRoot}`)) throw new TypeError("Android CLI describe target does not match the requested project root");
	if (!lines.includes(`Project directory exists: ${canonicalProjectRoot}`)) throw new TypeError("Android CLI did not confirm the requested project directory");
	if (!lines.includes("Parsed tasks:")) throw new TypeError("Android CLI report is missing its task section");
	if (!lines.includes("gradlew completed successfully.")) throw new TypeError("Android CLI did not complete Gradle description successfully");
	const modules = /* @__PURE__ */ new Map();
	let currentModule;
	let currentVariant;
	for (const line of lines) {
		const task = /^Task: (:[^\s]+)$/u.exec(line);
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
			if (!path.startsWith("/") && !/^[a-zA-Z]:[\\/]/u.test(path)) throw new TypeError(`Android CLI reported a non-absolute APK path: ${path}`);
			currentVariant.push({
				kind: "apk",
				path
			});
		}
	}
	if (modules.size === 0) throw new TypeError("Android CLI describe report declared no modules");
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
	const resolveIn = async (relative) => fs.resolve(relative, {
		cwd: rootPath,
		signal
	});
	const exists = async (relative) => {
		const target = await resolveIn(relative);
		return await fs.stat(target, signal) ? fs.processPath(target) : void 0;
	};
	for (const [kind, relative, detail] of [
		[
			"wrapper",
			"gradlew",
			"Gradle wrapper script; not executed by static inspection"
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
	if (!leads.some((lead) => lead.kind === "wrapper")) missing.push("gradlew");
	let entries = [];
	try {
		entries = await fs.listDir(await resolveIn("."), signal);
	} catch {
		entries = [];
	}
	let inspected = 0;
	for (const entry of entries) {
		if (inspected >= 50) break;
		if (entry.type !== "directory") continue;
		if (entry.name.startsWith(".") || entry.name === "build" || entry.name === "node_modules") continue;
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
	if (!leads.some((lead) => lead.kind === "module-dir")) missing.push("module build files");
	return Object.freeze({
		projectRoot: rootPath,
		leads: Object.freeze(leads),
		missing: Object.freeze(missing),
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
