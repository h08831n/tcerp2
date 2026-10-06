import { Prisma } from '@prisma/client';

/**
 * Default printable description for a sales line (REQUIREMENTS §9):
 * `<template.nameFa> <attribute value fa joined ' / '>` — e.g.
 * «میلگرد ذوب آهن سایز 16 / گرید A3». ONE aggregated query for a whole
 * batch of variants (no N+1). The salesperson can still override the text
 * per line (`printableDescription`).
 */
export async function buildPrintableDescriptions(
  prisma: Prisma.TransactionClient | PrismaServiceLike,
  variantIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (variantIds.length === 0) return result;

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      template: { select: { nameFa: true } },
      values: {
        select: {
          attributeValue: { select: { valueFa: true } },
          attribute: { select: { displayOrder: true } },
        },
      },
    },
  });

  for (const variant of variants) {
    const values = [...variant.values]
      .sort((a, b) => a.attribute.displayOrder - b.attribute.displayOrder)
      .map((v) => v.attributeValue.valueFa);
    // «<template nameFa> <valueFa / valueFa / …>» — values joined with ' / '.
    const label = [variant.template.nameFa.trim(), values.join(' / ')].filter((part) => part.length > 0).join(' ');
    result.set(variant.id, label);
  }
  return result;
}

interface PrismaServiceLike {
  productVariant: {
    findMany(args: unknown): Promise<
      {
        id: string;
        template: { nameFa: string };
        values: { attributeValue: { valueFa: string }; attribute: { displayOrder: number } }[];
      }[]
    >;
  };
}
