/**
 * 共享配置层（M24 抽出的独立层）：配置文件与密钥文件的读写、WeChat 账号发现、路径解析。
 *
 * 依赖方向：`config/**` 是底层，不 import `keys/**` 或 `query/**`；`keys/**` 只依赖本层；
 * `query/**` 依赖本层与 `keys/**`。因此不存在环 —— 守卫用例见
 * `tests/layer-direction.spec.ts`。
 */
export * from './atomic-json.ts';
export * from './wechat-config.ts';
export * from './detect.ts';
export * from './resolve.ts';
