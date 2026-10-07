/**
 * Pure publishing-template rendering (no Prisma — fully unit-testable).
 *
 * Placeholders: {product} {variantSku} {size} {grade} {brand} {price} {date}
 * {uom}. A placeholder present in the TEMPLATE but missing from the vars is
 * left EMPTY and collected as a warning (never breaks the send).
 */
export interface RenderedBody {
  text: string;
  warnings: string[];
}

export function renderBody(
  bodyTemplate: string,
  vars: Record<string, string | null | undefined>,
): RenderedBody {
  const warnings: string[] = [];
  const text = String(bodyTemplate ?? '').replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name];
      return value === null || value === undefined ? '' : String(value);
    }
    warnings.push(`Unknown placeholder {${name}}`);
    return '';
  });
  return { text, warnings };
}
