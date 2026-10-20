//#region src/android/lib/reuse-source.ts
/** First concrete recognizer: Android main-source UI components and system wrappers.
* This is a conservative candidate finder, not a Kotlin/Java semantic parser.
* Ordinary resources, screen entry points, private declarations and preview functions are excluded.
* Reuse decisions still require reading the actual source and its direct consumers.
*/
const ANDROID_REUSE_SOURCE_REVISION = "android-main-surface-v1";
const uiNames = /(?:Banner|Bar|BottomSheet|Button|Card|Carousel|Checkbox|Chip|Container|Control|Dialog|Field|Footer|Grid|Header|Icon|Image|Indicator|Input|Item|Layout|List|Menu|Pager|Picker|Popup|Radio|Row|Scaffold|Section|Selector|Sheet|Slider|Snackbar|Switch|Tab|Text|Tile|Toolbar|View)$/u;
const excludedUiNames = /(?:Activity|Fragment|Page|Preview|Route|Screen)$/u;
const wrapperNames = /(?:Adapter|Analytics|Cache|Client|Coordinator|DataSource|Dispatcher|Engine|Factory|Gateway|Loader|Manager|Monitor|Navigator|Provider|Registry|Repository|Resolver|Scheduler|Service|Store|Tracker|Wrapper)$/u;
const sharedUiPath = /(?:^|\/)(?:common|components?|design-system|designsystem|shared|widgets?)(?:\/|$)/iu;
const excludedDirectories = /* @__PURE__ */ new Set([
	".git",
	".gradle",
	".idea",
	".kotlin",
	".satellite",
	"build",
	"generated",
	"node_modules",
	"out"
]);
function isAndroidReuseSource(path) {
	return !path.split("/").some((part) => excludedDirectories.has(part)) && /(?:^|\/)src\/main\//.test(path) && /\.(?:kt|java)$/.test(path);
}
function extractAndroidReuseSource(path, text) {
	if (!isAndroidReuseSource(path)) return [];
	const kotlin = path.endsWith(".kt"), lines = text.split(/\r?\n/);
	const result = [];
	let depth = 0, blockCommentDepth = 0, tripleString = false, annotationDepth = 0;
	let restrictedDeclaration = false;
	let annotations = [];
	function clean(line) {
		let out = "", quote = "", escaped = false;
		for (let i = 0; i < line.length; i++) {
			const c = line[i], pair = line.slice(i, i + 2), triple = line.slice(i, i + 3);
			if (blockCommentDepth > 0) {
				if (pair === "/*") {
					blockCommentDepth++;
					i++;
				} else if (pair === "*/") {
					blockCommentDepth--;
					i++;
				}
				continue;
			}
			if (tripleString) {
				if (triple === "\"\"\"") {
					tripleString = false;
					i += 2;
				}
				continue;
			}
			if (quote) {
				if (escaped) escaped = false;
				else if (c === "\\") escaped = true;
				else if (c === quote) quote = "";
				continue;
			}
			if (pair === "//") break;
			if (pair === "/*") {
				blockCommentDepth = 1;
				i++;
				continue;
			}
			if (triple === "\"\"\"") {
				tripleString = true;
				i += 2;
				continue;
			}
			if (c === "\"" || c === "'") {
				quote = c;
				continue;
			}
			out += c;
		}
		return out;
	}
	for (let index = 0; index < lines.length; index++) {
		const line = clean(lines[index]), trimmed = line.trim();
		const parentheses = [...line].reduce((n, c) => n + (c === "(" ? 1 : c === ")" ? -1 : 0), 0);
		if (annotationDepth > 0) {
			annotationDepth = Math.max(0, annotationDepth + parentheses);
			continue;
		}
		if (depth === 0) {
			const annotationMatches = [...trimmed.matchAll(/@([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
			annotations.push(...annotationMatches);
			if (trimmed.startsWith("@") && parentheses > 0) {
				annotationDepth = parentheses;
				continue;
			}
			const declaration = trimmed.replace(/@[A-Za-z_][\w.]*(?:\([^)]*\))?\s*/g, "");
			if (/^(?:(?:private|protected|public|internal|abstract|final|open|override|suspend|inline|tailrec|operator|infix|external)\s*)+$/.test(declaration)) {
				restrictedDeclaration ||= /\b(?:private|protected)\b/.test(declaration);
				continue;
			}
			if (!restrictedDeclaration && !/\b(?:private|protected)\b/.test(declaration)) {
				let kind, symbol;
				if (kotlin) {
					const fun = declaration.match(/^(?:(?:public|internal|suspend|inline|infix|operator|tailrec|external)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w?.<>]+\.)?([A-Za-z_]\w*)\s*\(/);
					if (fun && annotations.some((a) => a.endsWith("Composable")) && !annotations.some((a) => a.endsWith("Preview")) && !excludedUiNames.test(fun[1]) && (uiNames.test(fun[1]) || sharedUiPath.test(path))) {
						kind = "ui-component";
						symbol = fun[1];
					}
					const type = declaration.match(/^(?:(?:public|internal|abstract|annotation|data|enum|final|open|sealed|value)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/);
					if (type && wrapperNames.test(type[1])) {
						kind = "system-wrapper";
						symbol = type[1];
					}
				} else {
					const type = declaration.match(/^(?:(?:public|abstract|final|static|sealed|non-sealed)\s+)*(?:class|interface|enum)\s+([A-Za-z_]\w*)/);
					if (type && wrapperNames.test(type[1])) {
						kind = "system-wrapper";
						symbol = type[1];
					} else if (type && !excludedUiNames.test(type[1]) && uiNames.test(type[1]) && /\bextends\s+(?:[\w.]*)(?:View|ViewGroup|FrameLayout|LinearLayout|RelativeLayout)\b/.test(declaration)) {
						kind = "ui-component";
						symbol = type[1];
					}
				}
				if (kind && symbol) result.push({
					kind,
					symbol,
					line: index + 1,
					aliases: [.../* @__PURE__ */ new Set([symbol, symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()])]
				});
			}
			if (declaration && !/^(?:package|import)\s/.test(declaration)) {
				annotations = [];
				restrictedDeclaration = false;
			}
		}
		depth = Math.max(0, depth + [...line].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0));
	}
	return result.filter((entry, at) => result.findIndex((other) => other.kind === entry.kind && other.symbol === entry.symbol) === at);
}
//#endregion
export { ANDROID_REUSE_SOURCE_REVISION, extractAndroidReuseSource, isAndroidReuseSource };
