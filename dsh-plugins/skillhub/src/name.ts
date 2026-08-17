/**
 * Skill-name grammar shared by every skillhub operation. Mirrors the exact
 * kebab-case rule `@deepseek-ai/dsh-skill` enforces for locally-discovered
 * skills (`docs/subsystems/skills.md`), so a name this plugin accepts is
 * guaranteed to also be a valid on-disk skill directory name once installed.
 * @module dsh-plugin-skillhub/name
 */

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** True for a well-formed kebab-case skill name; false for anything else, including empty strings. */
export function isSkillName(value: string): boolean {
  return SKILL_NAME_PATTERN.test(value)
}

/** Same check, thrown as a descriptive error for a call site that wants to fail fast. */
export function assertSkillName(value: string, field = 'name'): void {
  if (!isSkillName(value)) {
    throw new Error(`skillhub: ${field} "${value}" is not a valid skill name (expected kebab-case, e.g. "my-skill")`)
  }
}
