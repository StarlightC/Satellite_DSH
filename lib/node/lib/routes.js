//#region src/node/lib/routes.ts
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
async function preflightRoute(input) {
	const { llm, selection, capabilities, role, providerName } = input;
	const options = role?.agentOptions;
	if (!options) return { ok: true };
	if (!capabilities?.agentOptions) return {
		ok: false,
		kind: "capability",
		reason: `后端 ${providerName} 不支持 agentOptions 角色路由，不能按角色绑定模型`
	};
	const { provider, model, reasoningEffort, maxTokens } = options;
	if (typeof provider !== "string" || provider.length === 0) return {
		ok: false,
		kind: "config",
		reason: "agentOptions.provider 必须是非空字符串"
	};
	if (typeof model !== "string" || model.length === 0) return {
		ok: false,
		kind: "config",
		reason: "agentOptions.model 必须是非空字符串"
	};
	if (selection && typeof selection === "object" && "error" in selection) return {
		ok: false,
		kind: "policy",
		reason: `模型选择策略不可用：${selection.error}`
	};
	if (selection?.enabled) {
		if (!(Array.isArray(selection.allowedModels) ? selection.allowedModels : []).some((route) => route?.provider === provider && route?.model === model)) return {
			ok: false,
			kind: "policy",
			reason: `路由 ${provider}/${model} 不在宿主允许的模型列表内（模型选择策略已启用）`
		};
	}
	if (llm && typeof llm.resolveCallConfig === "function") try {
		await llm.resolveCallConfig({
			provider,
			model,
			...reasoningEffort === void 0 ? {} : { reasoningEffort },
			...maxTokens === void 0 ? {} : { maxTokens }
		});
	} catch (error) {
		return {
			ok: false,
			kind: "route",
			reason: `模型适配器拒绝路由 ${provider}/${model}：${messageOf(error)}`
		};
	}
	return { ok: true };
}
//#endregion
export { preflightRoute };
