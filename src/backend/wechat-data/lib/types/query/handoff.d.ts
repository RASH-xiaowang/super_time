import type { HandoffRemindsSnapshot, TaskMutationResult } from '../types.ts';
/**
 * List native WeChat reminders.
 * @param decryptedDir - decrypted data root.
 * @returns the native reminder snapshot.
 */
export declare function listHandoffReminds(decryptedDir: string): HandoffRemindsSnapshot;
/**
 * Import native reminders into the plugin task store (deduped by title).
 * @param decryptedDir - decrypted data root.
 * @returns mutation result with added count.
 */
export declare function importHandoffTasks(decryptedDir: string): TaskMutationResult;
//# sourceMappingURL=handoff.d.ts.map