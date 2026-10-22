export interface AskSessionCatalogEntry {
    username: string;
    name: string;
}
export declare class AskCatalogCache {
    private readonly currentDirectory;
    private readonly entities;
    private readonly sessions;
    constructor(currentDirectory: () => string);
    private cached;
    /** 问答点名识别用的联系人/会话名称。 */
    entitiesForCurrentDirectory(): string[];
    /** 工具参数解析用的 username → 显示名目录。 */
    sessionsForCurrentDirectory(): AskSessionCatalogEntry[];
}
