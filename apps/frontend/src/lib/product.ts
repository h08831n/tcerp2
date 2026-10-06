/**
 * Product catalog API types and fetch helpers (Phase 3B contract).
 * Contract source of truth: apps/backend/src/products/* controllers + DTOs.
 */

import { API_BASE_URL, ApiError, apiJson } from "@/lib/api";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type ProductType = "STORABLE" | "CONSUMABLE" | "SERVICE";

export const PRODUCT_TYPES: ProductType[] = ["STORABLE", "CONSUMABLE", "SERVICE"];

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  STORABLE: "قابل نگهداری",
  CONSUMABLE: "مصرفی",
  SERVICE: "خدماتی",
};

export type SupplierMappingLevel = "VARIANT" | "TEMPLATE" | "CATEGORY";

export const SUPPLIER_MAPPING_LEVELS: SupplierMappingLevel[] = [
  "VARIANT",
  "TEMPLATE",
  "CATEGORY",
];

export const SUPPLIER_MAPPING_LEVEL_LABELS: Record<SupplierMappingLevel, string> = {
  VARIANT: "محصول",
  TEMPLATE: "خانواده محصول",
  CATEGORY: "گروه",
};

/** File categories allowed for product entities (files module). */
export type FileCategory =
  | "catalog"
  | "technical_specification"
  | "certificate"
  | "image"
  | "other";

export const FILE_CATEGORIES: FileCategory[] = [
  "catalog",
  "technical_specification",
  "certificate",
  "image",
  "other",
];

export const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
  catalog: "کاتالوگ",
  technical_specification: "مشخصات فنی",
  certificate: "گواهینامه",
  image: "تصویر",
  other: "سایر",
};

/** Well-known backend error tokens → Persian messages. */
export function productErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "CATEGORY_CYCLE")
      return "انتخاب این والد باعث ایجاد حلقه در درخت گروه‌ها می‌شود.";
    if (message === "UOM_CATEGORY_MISMATCH") return "واحدها در یک دسته نیستند.";
    if (message === "UOM_BASE_UNIT_EXISTS")
      return "برای این دسته قبلاً واحد پایه تعریف شده است.";
    if (message === "VARIANT_DUPLICATE_COMBINATION" || message === "VARIANT_COMBINATION_EXISTS")
      return "این ترکیب قبلاً برای این محصول ایجاد شده است.";
    if (message === "VARIANT_SKU_COLLISION")
      return "کد SKU تکراری است و امکان تولید کد جایگزین وجود ندارد.";
    if (message === "NOT_A_SUPPLIER")
      return "شخص انتخاب‌شده نقش تامین‌کننده ندارد.";
    if (message === "SUPPLIER_MAPPING_EXACTLY_ONE_LEVEL")
      return "هر نگاشت باید دقیقاً یک هدف (محصول، خانواده یا گروه) داشته باشد.";
    if (message === "VERSION_CONFLICT" || (message && message.includes("VERSION_CONFLICT")))
      return "رکورد توسط کاربر دیگری تغییر کرده است. لطفاً صفحه را بازخوانی کنید.";
    if (message.includes("internal code already exists"))
      return "این کد داخلی قبلاً در این شرکت ثبت شده است.";
    if (message.includes("Category code already exists"))
      return "این کد گروه قبلاً در این شرکت ثبت شده است.";
    if (message.includes("Brand code") || message.includes("code already exists in this company"))
      return "این کد قبلاً در این شرکت ثبت شده است.";
    if (message.includes("UOM symbol already exists"))
      return "این نماد واحد قبلاً در این شرکت ثبت شده است.";
    if (message.includes("UOM category code already exists"))
      return "این کد دسته واحد قبلاً ثبت شده است.";
    if (message.includes("Attribute code already exists"))
      return "این کد ویژگی قبلاً ثبت شده است.";
    if (message.includes("Value code already exists"))
      return "این کد مقدار برای این ویژگی تکراری است.";
    if (message.includes("Category is archived"))
      return "گروه انتخاب‌شده بایگانی شده است.";
    if (message.includes("Category has children or products"))
      return "این گروه دارای زیرگروه یا محصول است؛ به‌جای حذف، آن را بایگانی کنید.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// Shared envelopes
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

type ActiveFilter = "true" | "false" | "any";

function setActive(params: URLSearchParams, active: ActiveFilter | undefined) {
  if (active) params.set("active", active);
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CategoryDto {
  id: string;
  parentId: string | null;
  code: string;
  nameFa: string;
  nameEn: string | null;
  description: string | null;
  active: boolean;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  parent: { id: string; nameFa: string; code: string } | null;
  _count: { children: number; templates: number };
}

export interface CategoryQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  parentId?: string;
  active?: ActiveFilter;
}

export function fetchCategories(query: CategoryQuery = {}): Promise<PaginatedResponse<CategoryDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.parentId) params.set("parentId", query.parentId);
  setActive(params, query.active);
  return apiJson<PaginatedResponse<CategoryDto>>(`/categories?${params.toString()}`);
}

export interface CreateCategoryBody {
  code: string;
  nameFa: string;
  nameEn?: string;
  parentId?: string;
  description?: string;
  sortOrder?: number;
  active?: boolean;
}

export function createCategory(body: CreateCategoryBody): Promise<CategoryDto> {
  return apiJson<CategoryDto>("/categories", { method: "POST", body: JSON.stringify(body) });
}

export interface UpdateCategoryBody {
  parentId?: string | null;
  nameFa?: string;
  nameEn?: string;
  description?: string;
  sortOrder?: number;
  active?: boolean;
}

export function updateCategory(id: string, body: UpdateCategoryBody): Promise<CategoryDto> {
  return apiJson<CategoryDto>(`/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteCategory(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiJson<{ id: string; deleted: boolean }>(`/categories/${id}`, { method: "DELETE" });
}

/** Fetches every category (paginated endpoint, walked page by page). */
export async function fetchAllCategories(active: ActiveFilter = "any"): Promise<CategoryDto[]> {
  const out: CategoryDto[] = [];
  let page = 1;
  for (let guard = 0; guard < 20; guard += 1) {
    const response = await fetchCategories({ page, pageSize: 100, active });
    out.push(...response.items);
    if (out.length >= response.total || response.items.length === 0) break;
    page += 1;
  }
  return out;
}

export interface CategoryNode {
  category: CategoryDto;
  children: CategoryNode[];
}

/** Builds an ordered tree from the flat category list. */
export function buildCategoryTree(items: CategoryDto[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  for (const item of items) byId.set(item.id, { category: item, children: [] });
  const roots: CategoryNode[] = [];
  byId.forEach((node) => {
    const parentId = node.category.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  const sortNodes = (nodes: CategoryNode[]) => {
    nodes.sort(
      (a, b) =>
        a.category.sortOrder - b.category.sortOrder ||
        a.category.nameFa.localeCompare(b.category.nameFa, "fa"),
    );
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export interface BrandDto {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  logoAttachmentId: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BrandQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  active?: ActiveFilter;
}

export function fetchBrands(query: BrandQuery = {}): Promise<PaginatedResponse<BrandDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  setActive(params, query.active);
  return apiJson<PaginatedResponse<BrandDto>>(`/brands?${params.toString()}`);
}

export async function fetchAllBrands(active: ActiveFilter = "true"): Promise<BrandDto[]> {
  const response = await fetchBrands({ page: 1, pageSize: 100, active });
  return response.items;
}

export interface CreateBrandBody {
  code: string;
  nameFa: string;
  nameEn?: string;
  logoAttachmentId?: string;
  active?: boolean;
}

export function createBrand(body: CreateBrandBody): Promise<BrandDto> {
  return apiJson<BrandDto>("/brands", { method: "POST", body: JSON.stringify(body) });
}

export interface UpdateBrandBody {
  nameFa?: string;
  nameEn?: string;
  logoAttachmentId?: string | null;
  active?: boolean;
}

export function updateBrand(id: string, body: UpdateBrandBody): Promise<BrandDto> {
  return apiJson<BrandDto>(`/brands/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// UOMs
// ---------------------------------------------------------------------------

export interface UomDto {
  id: string;
  categoryId: string;
  category: { id: string; nameFa: string; code: string };
  nameFa: string;
  nameEn: string | null;
  symbol: string;
  conversionRatio: string;
  isBaseUnit: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UomCategoryDto {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  uoms: UomDto[];
}

export function fetchUomCategories(): Promise<UomCategoryDto[]> {
  return apiJson<UomCategoryDto[]>("/uoms/categories");
}

export interface CreateUomCategoryBody {
  code: string;
  nameFa: string;
  nameEn?: string;
}

export function createUomCategory(body: CreateUomCategoryBody): Promise<UomCategoryDto> {
  return apiJson<UomCategoryDto>("/uoms/categories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateUomCategoryBody {
  nameFa?: string;
  nameEn?: string;
}

export function updateUomCategory(
  id: string,
  body: UpdateUomCategoryBody,
): Promise<UomCategoryDto> {
  return apiJson<UomCategoryDto>(`/uoms/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export interface UomQuery {
  categoryId?: string;
  active?: boolean;
}

export function fetchUoms(query: UomQuery = {}): Promise<PaginatedResponse<UomDto>> {
  const params = new URLSearchParams();
  if (query.categoryId) params.set("categoryId", query.categoryId);
  if (query.active !== undefined) params.set("active", String(query.active));
  return apiJson<PaginatedResponse<UomDto>>(`/uoms?${params.toString()}`);
}

export async function fetchAllUoms(active?: boolean): Promise<UomDto[]> {
  const response = await fetchUoms({ ...(active !== undefined ? { active } : {}) });
  return response.items;
}

export interface CreateUomBody {
  categoryId: string;
  nameFa: string;
  nameEn?: string;
  symbol: string;
  conversionRatio: string;
  isBaseUnit?: boolean;
  active?: boolean;
}

export function createUom(body: CreateUomBody): Promise<UomDto> {
  return apiJson<UomDto>("/uoms", { method: "POST", body: JSON.stringify(body) });
}

export interface UpdateUomBody {
  nameFa?: string;
  nameEn?: string;
  conversionRatio?: string;
  isBaseUnit?: boolean;
  active?: boolean;
}

export function updateUom(id: string, body: UpdateUomBody): Promise<UomDto> {
  return apiJson<UomDto>(`/uoms/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export interface UomConvertResult {
  value: string;
  fromSymbol: string;
  toSymbol: string;
  categoryId: string;
}

export function convertUom(body: {
  value: string;
  fromUomId: string;
  toUomId: string;
}): Promise<UomConvertResult> {
  return apiJson<UomConvertResult>("/products/uom/convert", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Attributes + values
// ---------------------------------------------------------------------------

export interface AttributeValueDto {
  id: string;
  attributeId: string;
  code: string;
  valueFa: string;
  valueEn: string | null;
  numericValue: string | null;
  displayOrder: number;
  active: boolean;
}

export interface AttributeDto {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  displayOrder: number;
  active: boolean;
  values: AttributeValueDto[];
}

export interface AttributeQuery {
  active?: boolean;
}

export function fetchAttributes(query: AttributeQuery = {}): Promise<PaginatedResponse<AttributeDto>> {
  const params = new URLSearchParams();
  if (query.active !== undefined) params.set("active", String(query.active));
  return apiJson<PaginatedResponse<AttributeDto>>(
    `/products/attributes?${params.toString()}`,
  );
}

export interface CreateAttributeBody {
  code: string;
  nameFa: string;
  nameEn?: string;
  displayOrder?: number;
  active?: boolean;
}

export function createAttribute(body: CreateAttributeBody): Promise<AttributeDto> {
  return apiJson<AttributeDto>("/products/attributes", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateAttributeBody {
  nameFa?: string;
  nameEn?: string;
  displayOrder?: number;
  active?: boolean;
}

export function updateAttribute(id: string, body: UpdateAttributeBody): Promise<AttributeDto> {
  return apiJson<AttributeDto>(`/products/attributes/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function fetchAttributeValues(attributeId: string): Promise<AttributeValueDto[]> {
  return apiJson<AttributeValueDto[]>(
    `/products/attribute-values?attributeId=${encodeURIComponent(attributeId)}`,
  );
}

export interface CreateAttributeValueBody {
  attributeId: string;
  code: string;
  valueFa: string;
  valueEn?: string;
  numericValue?: string;
  displayOrder?: number;
  active?: boolean;
}

export function createAttributeValue(
  body: CreateAttributeValueBody,
): Promise<AttributeValueDto> {
  return apiJson<AttributeValueDto>("/products/attribute-values", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateAttributeValueBody {
  valueFa?: string;
  valueEn?: string;
  numericValue?: string;
  displayOrder?: number;
  active?: boolean;
}

export function updateAttributeValue(
  id: string,
  body: UpdateAttributeValueBody,
): Promise<AttributeValueDto> {
  return apiJson<AttributeValueDto>(`/products/attribute-values/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateListItem {
  id: string;
  nameFa: string;
  nameEn: string | null;
  internalCode: string | null;
  category: { id: string; nameFa: string } | null;
  brand: { id: string; nameFa: string } | null;
  productType: ProductType;
  active: boolean;
  version: number;
  createdAt: string;
  variantsCount: number;
}

export interface TemplateQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  categoryId?: string;
  brandId?: string;
  productType?: ProductType;
  active?: ActiveFilter;
}

export function fetchTemplates(query: TemplateQuery = {}): Promise<PaginatedResponse<TemplateListItem>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.categoryId) params.set("categoryId", query.categoryId);
  if (query.brandId) params.set("brandId", query.brandId);
  if (query.productType) params.set("productType", query.productType);
  setActive(params, query.active);
  return apiJson<PaginatedResponse<TemplateListItem>>(
    `/products/templates?${params.toString()}`,
  );
}

export interface TemplateAttributeDto {
  id: string;
  templateId: string;
  attributeId: string;
  displayOrder: number;
  createsVariants: boolean;
  isRequired: boolean;
  attribute: AttributeDto;
}

export interface VariantValueDto {
  id: string;
  attributeId: string;
  attributeValueId: string;
  attributeValue: {
    id: string;
    code: string;
    valueFa: string;
    valueEn: string | null;
  };
}

export interface VariantDto {
  id: string;
  sku: string;
  nameFa: string;
  nameEn: string | null;
  weightPerUnit: string | null;
  active: boolean;
  defaultUom: { id: string; nameFa: string; symbol: string } | null;
  values: VariantValueDto[];
}

export interface TemplateDetail {
  id: string;
  nameFa: string;
  nameEn: string | null;
  internalCode: string | null;
  description: string | null;
  productType: ProductType;
  isSellable: boolean;
  isPurchasable: boolean;
  defaultSalesPrice: string | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  category: { id: string; nameFa: string; nameEn: string | null; code: string };
  brand: { id: string; nameFa: string; nameEn: string | null; code: string } | null;
  salesUom: { id: string; nameFa: string; symbol: string } | null;
  purchaseUom: { id: string; nameFa: string; symbol: string } | null;
  taxDefinition: { id: string; name: string } | null;
  attributes: TemplateAttributeDto[];
  variants: VariantDto[];
}

export function fetchTemplate(id: string): Promise<TemplateDetail> {
  return apiJson<TemplateDetail>(`/products/templates/${id}`);
}

export interface CreateTemplateBody {
  categoryId: string;
  brandId?: string;
  nameFa: string;
  nameEn?: string;
  internalCode?: string;
  description?: string;
  productType?: ProductType;
  isSellable?: boolean;
  isPurchasable?: boolean;
  defaultSalesUomId?: string;
  defaultPurchaseUomId?: string;
  defaultSalesPrice?: string;
  defaultTaxDefinitionId?: string;
}

export function createTemplate(body: CreateTemplateBody): Promise<TemplateDetail> {
  return apiJson<TemplateDetail>("/products/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateTemplateBody {
  categoryId?: string;
  brandId?: string | null;
  nameFa?: string;
  nameEn?: string;
  internalCode?: string;
  description?: string;
  productType?: ProductType;
  isSellable?: boolean;
  isPurchasable?: boolean;
  defaultSalesUomId?: string;
  defaultPurchaseUomId?: string;
  defaultSalesPrice?: string;
  defaultTaxDefinitionId?: string;
  version: number;
}

export function updateTemplate(
  id: string,
  body: UpdateTemplateBody,
): Promise<TemplateDetail> {
  return apiJson<TemplateDetail>(`/products/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function archiveTemplate(id: string): Promise<TemplateDetail> {
  return apiJson<TemplateDetail>(`/products/templates/${id}`, { method: "DELETE" });
}

// ── template attributes ──

export interface AddTemplateAttributeBody {
  attributeId: string;
  displayOrder?: number;
  createsVariants?: boolean;
  isRequired?: boolean;
}

export function addTemplateAttribute(
  templateId: string,
  body: AddTemplateAttributeBody,
): Promise<TemplateAttributeDto> {
  return apiJson<TemplateAttributeDto>(`/products/templates/${templateId}/attributes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateTemplateAttributeBody {
  displayOrder?: number;
  createsVariants?: boolean;
  isRequired?: boolean;
}

export function updateTemplateAttribute(
  templateId: string,
  attributeId: string,
  body: UpdateTemplateAttributeBody,
): Promise<TemplateAttributeDto> {
  return apiJson<TemplateAttributeDto>(
    `/products/templates/${templateId}/attributes/${attributeId}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
}

export function removeTemplateAttribute(
  templateId: string,
  attributeId: string,
): Promise<{ templateId: string; attributeId: string; removed: boolean }> {
  return apiJson<{ templateId: string; attributeId: string; removed: boolean }>(
    `/products/templates/${templateId}/attributes/${attributeId}`,
    { method: "DELETE" },
  );
}

// ── variants: preview / generate / matrix ──

export interface PreviewSelection {
  attributeId: string;
  valueIds: string[];
}

export interface PreviewCombination {
  combination: {
    attributeId: string;
    attributeCode: string;
    valueId: string;
    valueCode: string;
  }[];
  skuSuggestion: string;
  existsAlready: boolean;
}

export function previewVariants(
  templateId: string,
  selections: PreviewSelection[],
): Promise<{ combinations: PreviewCombination[] }> {
  return apiJson<{ combinations: PreviewCombination[] }>(
    `/products/templates/${templateId}/variants/preview`,
    { method: "POST", body: JSON.stringify({ selections }) },
  );
}

export interface GenerateCombination {
  selections: { attributeId: string; valueId: string }[];
}

export interface GenerateResult {
  created: { id: string; sku: string }[];
  skipped: { combination: { attributeId: string; valueId: string }[]; reason: string }[];
}

export function generateVariants(
  templateId: string,
  combinations: GenerateCombination[],
): Promise<GenerateResult> {
  return apiJson<GenerateResult>(`/products/templates/${templateId}/variants/generate`, {
    method: "POST",
    body: JSON.stringify({ combinations }),
  });
}

export interface MatrixSpace {
  attributeId: string;
  nameFa: string;
  values: { id: string; code: string; valueFa: string }[];
}

export interface MatrixCell {
  combination: { attributeId: string; valueId: string }[];
  variantId: string;
  sku: string;
  active: boolean;
}

export function fetchMatrix(
  templateId: string,
): Promise<{ columns: MatrixSpace[]; rows: MatrixSpace[]; cells: MatrixCell[] }> {
  return apiJson<{ columns: MatrixSpace[]; rows: MatrixSpace[]; cells: MatrixCell[] }>(
    `/products/templates/${templateId}/matrix`,
  );
}

// ---------------------------------------------------------------------------
// Supplier mappings
// ---------------------------------------------------------------------------

export interface SupplierMappingDto {
  id: string;
  supplierPartyId: string;
  supplierParty: { id: string; nameFa: string };
  mappingLevel: SupplierMappingLevel;
  productVariantId: string | null;
  productVariant: { id: string; sku: string; nameFa: string } | null;
  productTemplateId: string | null;
  productTemplate: { id: string; nameFa: string; internalCode: string | null } | null;
  categoryId: string | null;
  category: { id: string; nameFa: string } | null;
  supplierProductCode: string | null;
  supplierProductName: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierMappingQuery {
  page?: number;
  pageSize?: number;
  supplierPartyId?: string;
  mappingLevel?: SupplierMappingLevel;
  isActive?: boolean;
}

export function fetchSupplierMappings(
  query: SupplierMappingQuery = {},
): Promise<PaginatedResponse<SupplierMappingDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.supplierPartyId) params.set("supplierPartyId", query.supplierPartyId);
  if (query.mappingLevel) params.set("mappingLevel", query.mappingLevel);
  if (query.isActive !== undefined) params.set("isActive", String(query.isActive));
  return apiJson<PaginatedResponse<SupplierMappingDto>>(
    `/products/supplier-mappings?${params.toString()}`,
  );
}

export interface CreateSupplierMappingBody {
  supplierPartyId: string;
  mappingLevel: SupplierMappingLevel;
  productVariantId?: string;
  productTemplateId?: string;
  categoryId?: string;
  supplierProductCode?: string;
  supplierProductName?: string;
  notes?: string;
  isActive?: boolean;
}

export function createSupplierMapping(
  body: CreateSupplierMappingBody,
): Promise<SupplierMappingDto> {
  return apiJson<SupplierMappingDto>("/products/supplier-mappings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateSupplierMappingBody {
  supplierPartyId?: string;
  mappingLevel?: SupplierMappingLevel;
  productVariantId?: string | null;
  productTemplateId?: string | null;
  categoryId?: string | null;
  supplierProductCode?: string;
  supplierProductName?: string;
  notes?: string;
  isActive?: boolean;
}

export function updateSupplierMapping(
  id: string,
  body: UpdateSupplierMappingBody,
): Promise<SupplierMappingDto> {
  return apiJson<SupplierMappingDto>(`/products/supplier-mappings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tax definitions (optional reference data for template default tax)
// ---------------------------------------------------------------------------

export interface TaxDefinitionDto {
  id: string;
  name: string;
  code?: string;
  rate?: string;
  active?: boolean;
}

export async function fetchTaxDefinitions(): Promise<TaxDefinitionDto[]> {
  const data = await apiJson<unknown>("/tax/definitions");
  return Array.isArray(data) ? (data as TaxDefinitionDto[]) : [];
}

// ---------------------------------------------------------------------------
// Files / attachments
// ---------------------------------------------------------------------------

export interface FileBlobDto {
  id: string;
  size: number;
  contentType?: string;
  sha256?: string;
}

export interface AttachmentDto {
  id: string;
  fileBlobId: string;
  entityType: string;
  entityId: string;
  originalFilename: string;
  displayName: string | null;
  category: string | null;
  createdAt: string;
  blob: FileBlobDto;
}

export function fetchAttachments(entityType: string, entityId: string): Promise<AttachmentDto[]> {
  const params = new URLSearchParams({ entityType, entityId });
  return apiJson<AttachmentDto[]>(`/files/attachments?${params.toString()}`);
}

export async function uploadAttachment(options: {
  file: File;
  entityType: string;
  entityId: string;
  category?: string;
  displayName?: string;
}): Promise<AttachmentDto> {
  const form = new FormData();
  form.append("file", options.file);
  form.append("entityType", options.entityType);
  form.append("entityId", options.entityId);
  if (options.category) form.append("category", options.category);
  if (options.displayName) form.append("displayName", options.displayName);
  return apiJson<AttachmentDto>("/files", { method: "POST", body: form });
}

/** Direct download URL (cookies ride along on the navigation request). */
export function attachmentDownloadUrl(attachmentId: string): string {
  return `${API_BASE_URL}/files/attachments/${attachmentId}/download`;
}

// ---------------------------------------------------------------------------
// Audit (history tab)
// ---------------------------------------------------------------------------

export interface AuditEntryDto {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string | null;
  actor?: { id: string; username: string } | null;
  oldValues?: unknown;
  newValues?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export function fetchAudit(options: {
  entityType: string;
  entityId: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<AuditEntryDto>> {
  const params = new URLSearchParams({
    entityType: options.entityType,
    entityId: options.entityId,
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 50),
  });
  return apiJson<PaginatedResponse<AuditEntryDto>>(`/audit?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Shared value formatting helpers
// ---------------------------------------------------------------------------

/** Parses a user money/decimal input (Persian digits, commas) to a plain string. */
export function parseDecimalInput(raw: string): string {
  const normalized = raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[,،\s]/g, "")
    .trim();
  if (!normalized || !/^-?\d+(\.\d+)?$/.test(normalized)) return "";
  return normalized;
}
