/** 文件库文件名（登记行 + 分块 + FTS 都在这里面）。 */
export declare const KB_FILES_DB = "wechat_kb_files.db";
/** blob 副本目录名（内容寻址，`<sha256>.<ext>`）。 */
export declare const KB_BLOBS_DIR = "kb-blobs";
/** 向量库文件名（独立一个文件：见 `kb-vectors.ts` 头注的两条理由）。 */
export declare const KB_VECTORS_DB = "wechat_kb_vectors.db";
/**
 * 每库模型设置的文件名。
 *
 * 为什么又单开一个库而不是给 `kbs` 加列：`notes.ts` 的头注自述「只读写本地库，
 * 不出网、不调用模型」，而这张表存在的唯一理由就是「本库用哪个模型出网」——
 * 放进去等于让笔记模块变成模型配置的载体之一。`KB-COMPLETION-PLAN` §C1 的约束因此保留。
 * 它与 `wechat_kb_files.db` 也不同文件：那张表是**内容**（会随删文件而变），
 * 这张是**选择**（删库时才一起消失），两者生命周期不同。
 */
export declare const KB_MODELS_DB = "wechat_kb_models.db";
/** 文件库路径（导出是为了让守卫用例能断言它与笔记库是两个文件）。 */
export declare function kbFilesDbPath(decryptedDir: string): string;
/** blob 副本目录（导出为了探针能直接检查副本是否被删）。 */
export declare function kbBlobsDir(decryptedDir: string): string;
/** 向量库路径（与另两个产物同址）。 */
export declare function kbVectorsDbPath(decryptedDir: string): string;
/** 每库模型设置的路径（同样在 `dirname(decryptedDir)` 下）。 */
export declare function kbModelsDbPath(decryptedDir: string): string;
