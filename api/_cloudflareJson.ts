/** PostgreSQL JSONB object concatenation is a shallow merge. SQLite json_patch
 * recursively merges objects and deletes nulls, so it cannot replace that
 * operation for task metadata, saved results or user-provided values.
 * Arguments here must be trusted SQL expressions, never request text. */
export function shallowJsonMerge(left: string, right: string): string {
  return `(SELECT json_group_object(key,json(CASE type
    WHEN 'object' THEN value WHEN 'array' THEN value
    WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null'
    ELSE json_quote(value) END)) FROM (
      SELECT original.key,original.value,original.type FROM json_each(COALESCE(${left},'{}')) original
      WHERE NOT EXISTS(SELECT 1 FROM json_each(COALESCE(${right},'{}')) replacement WHERE replacement.key=original.key)
      UNION ALL SELECT key,value,type FROM json_each(COALESCE(${right},'{}'))
    ))`
}
