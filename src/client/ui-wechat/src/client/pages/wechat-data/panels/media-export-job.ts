/** Generate the job id shared by a frontend save operation and its backend RPC. */
export function mediaExportJobId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${String(Math.random()).slice(2)}`
  return `${prefix}-${suffix}`
}
