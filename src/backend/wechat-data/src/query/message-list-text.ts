/** Plain-text fallback shared by ordinary message-list delivery. */
export function degradeToText(text: string): string {
  return text.replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '').replace(/\[(.*?)\]\((.*?)\)/g, '$1').trim()
}
