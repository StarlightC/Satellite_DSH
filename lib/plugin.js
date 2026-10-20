//#region src/plugin.ts
/**
* Satellite 插件本体行（包根）。
*
* 一次安装包含四个可分别启停的行；本行是插件自身的身份入口，
* 目前不注册资源，只承载插件级标题与描述。子组件行：
*   satellite/slots    插槽服务
*   satellite/node     节点工具（satellite_node）
*   satellite/android  Android 只读扩展（默认停用）
*/
function apply() {}
//#endregion
export { apply };
