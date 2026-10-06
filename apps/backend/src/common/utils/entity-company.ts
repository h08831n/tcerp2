import { ValidationError } from '../errors';

/**
 * Phase 3B correction #5 — single FK-integrity guard. Whenever a
 * client-supplied id is dereferenced into a company-scoped row, the row must
 * exist AND belong to the caller's company. Used consistently by the catalog
 * services for: Category.parent, Brand (+ logo attachment company_id),
 * Template.category/brand/salesUom/purchaseUom/taxDefinition,
 * TemplateAttribute.attribute (+ selected attribute values, via the
 * attribute), Variant.template/defaultUom/weightUom,
 * SupplierMapping.supplierParty/targets and file-attachment targets.
 *
 * Convention (matching the existing catalog services): a cross-company or
 * missing FK target is a 422 ValidationError whose message names the
 * resource — rows of other companies are never addressable.
 */
export function assertSameCompany<T extends { companyId?: string | null }>(
  companyId: string,
  entity: T | null | undefined,
  message = 'Resource not found in this company',
): T {
  if (!entity || (entity.companyId ?? null) !== companyId) {
    throw new ValidationError(message, { companyId });
  }
  return entity;
}
