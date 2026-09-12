/**
 * Collect every friend in the subtree of a region node, deduplicated by username.
 * @param node - current region node (or the world root when on the world level).
 * @returns the friend list in tree order.
 */
export function collectSubtreeFriends(node) {
    const out = [];
    const seen = new Set();
    const walk = (n) => {
        for (const f of n.friends) {
            if (!seen.has(f.username)) {
                seen.add(f.username);
                out.push(f);
            }
        }
        for (const c of n.children)
            walk(c);
    };
    if (node)
        walk(node);
    return out;
}
//# sourceMappingURL=region-friends.js.map