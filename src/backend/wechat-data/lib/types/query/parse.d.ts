/**
 * WeChat message XML content parsing — rewritten from st_control
 * modules/messages/parse.rs + media/rich.rs. Produces the PC-style display
 * text and a rich media descriptor for the 16 message types.
 */
/**
 * Strip all XML tags from a string, collapsing whitespace.
 * Tags are removed without inserting a separator (mirrors st_control’s
 * strip_xml_tags) so system-message placeholders keep their original
 * spacing.
 * @param xml - raw XML string.
 * @returns the tag-stripped, whitespace-collapsed text.
 */
export declare function stripXmlTags(xml: string): string;
/**
 * Extract the text of the first occurrence of a tag.
 * Handles CDATA-wrapped content (<![CDATA[...]]>) which wechat appmsg uses
 * for title/des/thumburl — the plain text regex would stop at the first '<'.
 * @param xml - raw XML string.
 * @param tag - tag name to extract.
 * @returns the tag's inner text ('' when absent).
 */
export declare function xmlTagText(xml: string, tag: string): string;
import type { MessageRich as RichMedia } from '../types.ts';
/**
 * Parse one message content into display text + rich descriptor.
 * @param msgType - normalized message type.
 * @param content - raw message content.
 * @param isGroup - whether the message belongs to a group chat.
 * @returns display text plus an optional rich media descriptor.
 */
export declare function parseMessageContent(msgType: number, content: string, isGroup?: boolean): {
    text: string;
    rich?: RichMedia;
};
//# sourceMappingURL=parse.d.ts.map