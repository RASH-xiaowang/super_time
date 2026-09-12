/**
 * Render the contacts panel.
 * @param props - onNavigate to jump tabs; onOpenChat to open a session;
 *   onOpenMoments to jump to a member's timeline.
 * @returns the contacts element tree.
 */
export declare function ContactsPanel({ onNavigate, onOpenChat, onOpenMoments }: {
    onNavigate?: (tab: string) => void;
    onOpenChat?: (username: string) => void;
    onOpenMoments?: (username: string) => void;
}): React.JSX.Element;
//# sourceMappingURL=Contacts.d.ts.map