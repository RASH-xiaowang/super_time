import { HandoffRemindsSnapshot, NoteMutationResult, NotesSnapshot, OperationCategory, OperationStatus, TaskMutationResult, TasksSnapshot } from '../types.ts';
export interface createTasksRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
}
export declare function createTasksRemotes(rc: createTasksRemotesInputs): {
    getNotes(kbId: number, options?: {
        query?: string;
        limit?: number;
    }): NotesSnapshot;
    saveNote(kbId: number, options: {
        id?: number;
        title: string;
        body?: string;
        tags?: string[] | string;
        sourceKind?: "manual" | "ask";
        sourceUsername?: string;
        sourceQuestion?: string;
    }): NoteMutationResult;
    deleteNote(kbId: number, options: {
        id: number;
    }): NoteMutationResult;
    listTasks(): TasksSnapshot;
    addTask(options: {
        title: string;
        dueAt?: number;
    }): TaskMutationResult;
    deleteTask(options: {
        id: number;
    }): TaskMutationResult;
    setTaskStatus(options: {
        id: number;
        status: "open" | "done";
    }): TaskMutationResult;
    extractTasks(options?: {
        days?: number;
    }): TaskMutationResult;
    syncHandoffTasks(): TaskMutationResult;
    getHandoffReminds(): HandoffRemindsSnapshot;
};
