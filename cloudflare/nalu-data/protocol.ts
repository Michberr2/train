export const DOCUMENT_PART_BYTES = 524288
// Twenty inline entries, including JSON escaping, remain below the request cap.
export const DOCUMENT_INLINE_BYTES = 32768
export const DOCUMENT_MAX_BYTES = 64 * 1024 * 1024
export const DOCUMENT_MAX_PARTS = Math.ceil(DOCUMENT_MAX_BYTES / DOCUMENT_PART_BYTES)
export type DocumentManifest = { parts: string[]; sha256: string; byteLength: number }
export type WireDocument = { key: string; value?: string; manifest?: DocumentManifest; updated_at?: string }
export type DataStatement = { bind(...values: unknown[]): DataStatement; all(): Promise<{ results: Record<string, unknown>[] }>; first(): Promise<Record<string, unknown> | null> }
export type DataDatabase = { prepare(sql: string): DataStatement; batch(statements: DataStatement[]): Promise<{ results: Record<string, unknown>[] }[]> }
export const validDataId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\u0000-\u001f]/.test(value)
export const validDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
