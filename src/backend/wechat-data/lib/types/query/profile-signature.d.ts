/**
 * Normalize contact signatures before they reach the UI.
 *
 * Enterprise WeChat may store a JSON profile envelope in the signature slot,
 * e.g. a `custom_info` array describing the source and company. That envelope
 * is metadata, not a personal signature. Only return a value when the JSON
 * explicitly labels or names a signature; otherwise callers should render the
 * field as unset.
 */
/**
 * Return a human-readable signature, never the raw enterprise profile JSON.
 * @param raw - `contact.description` or `extra_buffer` field 4.
 * @returns cleaned signature text, or an empty string when the field has no
 *   explicit personal signature.
 */
export declare function readableProfileSignature(raw: string | undefined): string;
